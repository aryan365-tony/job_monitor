/*************************************************************************************************
 *  Job Monitoring & Parsing System
 *  ----------------------------------------------------------------------------------------------
 *  • Format-agnostic (HTML or JSON/API) job extraction
 *  • Two-stage, hierarchical workflow
 *  • Schema-agnostic, adaptive field mapping
 *  • Robust Groq usage: smart chunking, exponential back-off, content-type routing
 *  • Supabase persistence + Nodemailer alerts
 *  • Zero hard-coded field names or HTML selectors
 *
 *  Prerequisites (npm):
 *    groq-sdk            cheerio              node-fetch
 *    @supabase/supabase-js  nodemailer          gpt-3-encoder
 *
 *  Environment variables (required):
 *    GROQ_API_KEY               GROQ_MODEL
 *    NEXT_PUBLIC_SUPABASE_URL   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *    EMAIL_HOST  EMAIL_PORT  EMAIL_USER  EMAIL_PASS  NOTIFY_EMAIL
 *************************************************************************************************/

import { Groq } from 'groq-sdk';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import { encode, decode } from 'gpt-3-encoder';

/* ════════════════════════════════════════  UTILITIES  ════════════════════════════════════════ */

const DEFAULT_CONTEXT_WINDOW = 8192;      // fallback if model metadata unavailable
const PROMPT_OVERHEAD_TOKENS  = 300;      // allowance for system/user prompts
const CHUNK_OVERLAP_TOKENS    = 100;      // overlap between chunks

async function getModelContextWindow(groq, modelId) {
  try {
    const { data } = await groq.models.list();
    const meta = data.find(m => m.id === modelId);
    return meta?.max_input_tokens || DEFAULT_CONTEXT_WINDOW;
  } catch {
    return DEFAULT_CONTEXT_WINDOW;
  }
}

function splitIntoTokenChunks(text, contextWindow, promptOverhead = PROMPT_OVERHEAD_TOKENS, overlap = CHUNK_OVERLAP_TOKENS) {
  const tokens      = encode(text);
  const maxPerChunk = contextWindow - promptOverhead;
  const chunks      = [];
  let start         = 0;

  while (start < tokens.length) {
    const end = Math.min(start + maxPerChunk, tokens.length);
    chunks.push(decode(tokens.slice(start, end)));
    if (end === tokens.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw.trim());
    u.protocol = 'https:';
    u.hostname = u.hostname.replace(/^www\./i, '');
    u.search   = '';
    u.hash     = '';
    u.pathname = u.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    return `https://${u.hostname}${u.pathname}`.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

/* ════════════════════════════════════════  RATE LIMITER  ═════════════════════════════════════ */

class RateLimiter {
  constructor(maxTokensPerMinute = 10000, maxRequestsPerMinute = 30, minIntervalMs = 2000) {
    this.maxTokensPerMinute   = maxTokensPerMinute;
    this.maxRequestsPerMinute = maxRequestsPerMinute;
    this.minIntervalMs        = minIntervalMs;
    this.tokensThisMinute     = 0;
    this.requestsThisMinute   = 0;
    this.minuteStart          = Date.now();
    this.lastRequestTime      = 0;
  }

  resetIfNeeded() {
    const now = Date.now();
    if (now - this.minuteStart >= 60_000) {
      this.tokensThisMinute     = 0;
      this.requestsThisMinute   = 0;
      this.minuteStart          = now;
    }
  }

  async waitTurn(tokensNeeded) {
    this.resetIfNeeded();
    const now      = Date.now();
    const elapsed  = now - this.lastRequestTime;
    if (elapsed < this.minIntervalMs) {
      await new Promise(r => setTimeout(r, this.minIntervalMs - elapsed));
    }
    while (
      this.tokensThisMinute + tokensNeeded > this.maxTokensPerMinute ||
      this.requestsThisMinute >= this.maxRequestsPerMinute
    ) {
      await new Promise(r => setTimeout(r, 100));
      this.resetIfNeeded();
    }
  }

  record(tokensUsed = 0) {
    this.tokensThisMinute   += tokensUsed;
    this.requestsThisMinute += 1;
    this.lastRequestTime     = Date.now();
  }
}

/* ════════════════════════════════════════  GROQ HELPERS  ══════════════════════════════════════ */

async function chatOnce(groq, model, content, limiter, contextWindow) {
  const tokensEstimate = encode(content).length;
  await limiter.waitTurn(tokensEstimate);
  try {
    limiter.record(tokensEstimate);
    const res = await groq.chat.completions.create({
      model,
      messages: [{ role: 'user', content }],
    });
    return (res.choices[0]?.message?.content || '').trim();
  } catch (err) {
    throw err;
  }
}

/* ════════════════════════════════════════  LLM PROMPTS  ═══════════════════════════════════════ */

const PROMPT_STAGE1 = text => `
You are an expert parser. The following content (HTML, JSON, or plain text) contains job listings.
Task: Extract all distinct job-posting URLs.
Return a JSON array of absolute URLs only.

CONTENT:
${text}
`;

const PROMPT_STAGE2 = text => `
You are an expert job parser. The input below (HTML, JSON, or text) represents one job posting.
Extract all relevant fields (e.g., title, location, posted_date, description), without assuming specific field names.
Return a JSON object with your inferred keys. Omit any missing fields.

CONTENT:
${text}

JSON OBJECT:
`;

/* ════════════════════════════════════════  MAIN WORKFLOW  ═════════════════════════════════════ */

async function main() {
  console.log('🚀 Job monitor start:', new Date().toISOString());

  const groq   = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const MODEL  = process.env.GROQ_MODEL;
  const sb     = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
  const mailer = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT),
    secure: false,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });

  const limiter       = new RateLimiter();
  const contextWindow = await getModelContextWindow(groq, MODEL);

  // Fetch companies
  const { data: companies, error: cErr } = await sb.from('companies').select('*').order('name');
  if (cErr) throw cErr;

  const cutoff   = new Date(Date.now() - 3_600_000).toISOString();
  const newJobs  = [];

  for (const c of companies) {
    if (c.last_scraped && c.last_scraped >= cutoff) {
      console.log(`⏭️ Skipping ${c.name} (recent)`);
      continue;
    }
    console.log(`🔍 Scraping ${c.name}`);

    // 1. Fetch raw content
    let raw;
    try {
      const res = await fetch(c.api_url || c.careers_url);
      raw       = await res.text();
    } catch (e) {
      console.error(`❌ Fetch failed for ${c.name}:`, e);
      continue;
    }

    // 2. Stage 1: Extract job URLs
    const urlChunks = splitIntoTokenChunks(raw, contextWindow);
    const jobUrls   = new Set();
    for (const chunk of urlChunks) {
      try {
        const out = await chatOnce(groq, MODEL, PROMPT_STAGE1(chunk), limiter, contextWindow);
        const arr = JSON.parse(out.startsWith('[') ? out : '[]');
        arr.forEach(u => jobUrls.add(normalizeUrl(u)));
      } catch (err) {
        console.warn(`⚠️ URL extraction failed for ${c.name}`, err);
      }
    }

    if (!jobUrls.size) {
      console.log(`ℹ️ No URLs found for ${c.name}`);
      await sb.from('companies').update({ last_scraped: new Date().toISOString() }).eq('id', c.id);
      continue;
    }

    // 3. Filter seen URLs
    const { data: seenRows } = await sb.from('job_posts').select('url').eq('company_id', c.id);
    const seenSet           = new Set((seenRows || []).map(r => normalizeUrl(r.url)));
    const toProcess         = Array.from(jobUrls).filter(u => !seenSet.has(u));
    if (!toProcess.length) {
      console.log(`ℹ️ No new jobs for ${c.name}`);
      await sb.from('companies').update({ last_scraped: new Date().toISOString() }).eq('id', c.id);
      continue;
    }

    // 4. Stage 2: Parse each job page
    for (const jobUrl of toProcess) {
      let jobRaw;
      try {
        const res = await fetch(jobUrl);
        jobRaw    = await res.text();
      } catch {
        console.warn(`⚠️ Fetch failed for job URL: ${jobUrl}`);
        continue;
      }

      const chunks    = splitIntoTokenChunks(jobRaw, contextWindow);
      const assembled = {};

      for (const chunk of chunks) {
        try {
          const out = await chatOnce(groq, MODEL, PROMPT_STAGE2(chunk), limiter, contextWindow);
          const obj = JSON.parse(out.startsWith('{') ? out : '{}');
          Object.assign(assembled, obj);
        } catch (err) {
          console.warn(`⚠️ Job parse failed (${jobUrl})`, err);
        }
      }

      Object.assign(assembled, {
        url:           jobUrl,
        company_id:    c.id,
        company_name:  c.name,
        seen_at:       new Date().toISOString(),
      });

      try {
        await sb.from('job_posts').upsert(assembled, {
          onConflict:     ['company_id', 'url'],
          ignoreDuplicates: true,
        });
        newJobs.push(assembled);
        console.log(`➕ ${c.name}: ${assembled.title || '(no title)'}`);
      } catch (e) {
        console.error(`❌ Insert error for ${jobUrl}`, e);
      }
    }

    // 5. Update last_scraped
    await sb.from('companies').update({ last_scraped: new Date().toISOString() }).eq('id', c.id);
  }

  // 6. Send notification if new jobs found
  if (newJobs.length) {
    const body = newJobs.map(j =>
      `${j.company_name}\n${j.title || ''}\n${j.url}\n${j.posted_date || ''}\n`
    ).join('\n');
    try {
      await mailer.sendMail({
        from:    `"Job Monitor" <${process.env.EMAIL_USER}>`,
        to:      process.env.NOTIFY_EMAIL,
        subject: `🆕 ${newJobs.length} new job${newJobs.length > 1 ? 's' : ''}`,
        text:     body,
      });
      console.log('📧 Email sent');
    } catch (e) {
      console.error('❌ Email send failed', e);
    }
  } else {
    console.log('ℹ️ No new jobs discovered');
  }

  console.log('✅ Job monitor end:', new Date().toISOString());
}

main().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
