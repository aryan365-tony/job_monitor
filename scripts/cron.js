/*************************************************************************************************
 *  Job Monitoring & Parsing System
 *  ----------------------------------------------------------------------------------------------
 *  • Format-agnostic (HTML or API/JSON) job extraction
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
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import { encode, decode } from 'gpt-3-encoder';

/* ════════════════════════════════════════  UTILITIES  ════════════════════════════════════════ */

const MAX_TOKENS_PER_REQUEST = 2000;      // model-specific context limit
const PROMPT_OVERHEAD_TOKENS  = 300;      // allowance for system/user prompts
const CHUNK_OVERLAP_TOKENS    = 100;      // 5–10 % overlap to preserve context

function splitIntoTokenChunks(text, maxTokens = MAX_TOKENS_PER_REQUEST) {
  const tokens        = encode(text);
  const effectiveSize = maxTokens - PROMPT_OVERHEAD_TOKENS;
  const chunks        = [];
  let start           = 0;

  while (start < tokens.length) {
    const end   = Math.min(start + effectiveSize, tokens.length);
    chunks.push(decode(tokens.slice(start, end)));
    if (end === tokens.length) break;
    start = end - CHUNK_OVERLAP_TOKENS;
  }
  return chunks;
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw.trim());
    u.protocol = 'https:';            // force HTTPS
    u.hostname = u.hostname.replace(/^www\./i, '');
    u.search   = '';
    u.hash     = '';
    u.pathname = u.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    return `https://${u.hostname}${u.pathname}`.toLowerCase();
  } catch { return raw.trim().toLowerCase(); }
}

/* ════════════════════════════════════════  RATE LIMITER  ═════════════════════════════════════ */

class RateLimiter {
  constructor(maxPerMinute = 30, maxPerDay = 14400, minIntervalMs = 3500) {
    this.maxPerMinute   = maxPerMinute;
    this.maxPerDay      = maxPerDay;
    this.minIntervalMs  = minIntervalMs;
    this.thisMinute     = 0;
    this.today          = 0;
    this.minuteStart    = Date.now();
    this.dayStart       = Date.now();
    this.lastRequest    = 0;
  }
  resetMinute() { this.thisMinute = 0; this.minuteStart = Date.now(); }
  resetDay()    { this.today      = 0; this.dayStart   = Date.now(); }
  async waitTurn() {
    const now = Date.now();
    if (now - this.minuteStart > 60_000) this.resetMinute();
    if (now - this.dayStart    > 86_400_000) this.resetDay();

    const elapsed = now - this.lastRequest;
    if (elapsed < this.minIntervalMs)
      await new Promise(r => setTimeout(r, this.minIntervalMs - elapsed));

    if (this.thisMinute >= this.maxPerMinute || this.today >= this.maxPerDay)
      await new Promise(r => setTimeout(r, 1_000));   // simple throttle loop
  }
  record() {
    this.thisMinute++;  this.today++;  this.lastRequest = Date.now();
  }
}

/* ════════════════════════════════════════  GROQ HELPERS  ══════════════════════════════════════ */

async function chatOnce(groq, model, content, rateLimiter, retries = 3) {
  for (let i = 0; i < retries; i++) {
    await rateLimiter.waitTurn();
    try {
      rateLimiter.record();
      const res = await groq.chat.completions.create({
        model,
        messages: [{ role: 'user', content }],
      });
      return (res.choices?.[0]?.message?.content || '').trim();
    } catch (err) {
      const isCtx = err?.message?.includes('context_length_exceeded');
      if (isCtx) throw err;      // let caller decide to re-chunk
      if (i === retries - 1) throw err;
      const backoff = Math.min(1_000 * 2 ** i, 30_000);
      console.warn(`Groq error. Retry ${i + 1}/${retries} in ${backoff}ms`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
}

/* ════════════════════════════════════════  LLM PROMPTS  ═══════════════════════════════════════ */

const PROMPT_STAGE1 = text => `
You are an expert parser. The following content can be HTML, JSON, or plain text.
Task: Extract every *distinct* job-posting URL you can find.
Return a JSON array of canonical absolute URLs—nothing else.

CONTENT ↓↓↓
${text}
`;

const PROMPT_STAGE2 = text => `
You are an expert job parser. The input below (HTML, JSON, or text) represents *one*
job posting. Extract all relevant info *without assuming field names*.
Return a single JSON object with keys you infer, mapping to:
  url           title           location
  posted_date   description     department
  employment_type  salary       etc.

If a field isn't present, omit the key. Use ISO date when possible.

CONTENT ↓↓↓
${text}
JSON OBJECT:
`;

/* ════════════════════════════════════════  MAIN WORKFLOW  ═════════════════════════════════════ */

async function main() {
  console.log('🚀  Job monitor start:', new Date().toISOString());

  /* INITIALISE SERVICES */
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
  const limiter = new RateLimiter();

  /* FETCH COMPANIES TO SCRAPE */
  const { data: companies, error: cErr } =
    await sb.from('companies').select('*').order('name');
  if (cErr) throw cErr;

  const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const newJobs    = [];

  /* ──────────────────────────  LOOP OVER COMPANIES  ────────────────────────── */
  for (const c of companies) {
    if (c.last_scraped && c.last_scraped >= oneHourAgo) {
      console.log(`⏭️  Skipping ${c.name} (recent)`);
      continue;
    }
    console.log(`🔍  Scraping ${c.name}`);

    /* 1️⃣  DOWNLOAD CAREERS PAGE OR API */
    let raw;
    try {
      const res = await fetch(c.api_url || c.careers_url);
      raw       = await res.text();
    } catch (e) {
      console.error(`❌  Fetch failed for ${c.name}:`, e);
      continue;
    }

    /* 2️⃣  STAGE-1: EXTRACT JOB URLs (format-agnostic) */
    const urlChunks = splitIntoTokenChunks(raw);
    const jobUrls   = new Set();

    for (const chunk of urlChunks) {
      try {
        const out = await chatOnce(groq, MODEL, PROMPT_STAGE1(chunk), limiter);
        const arr = JSON.parse(out.startsWith('[') ? out : '[]');
        arr.forEach(u => jobUrls.add(normalizeUrl(u)));
      } catch (err) {
        console.warn(`⚠️  URL extraction chunk failed for ${c.name}`, err);
      }
    }
    if (!jobUrls.size) {
      console.log(`ℹ️  No URLs found for ${c.name}`);
      await sb.from('companies').update({ last_scraped: new Date().toISOString() })
               .eq('id', c.id);
      continue;
    }

    /* 3️⃣  FILTER ALREADY SEEN URLs */
    const { data: seenRows } =
      await sb.from('job_posts').select('url').eq('company_id', c.id);
    const seenSet   = new Set((seenRows || []).map(r => normalizeUrl(r.url)));
    const toProcess = Array.from(jobUrls).filter(u => !seenSet.has(u));

    if (!toProcess.length) {
      console.log(`ℹ️  No new jobs for ${c.name}`);
      await sb.from('companies').update({ last_scraped: new Date().toISOString() })
               .eq('id', c.id);
      continue;
    }

    /* 4️⃣  STAGE-2: PROCESS EACH NEW JOB PAGE */
    for (const jobUrl of toProcess) {
      let jobRaw;
      try {
        const res = await fetch(jobUrl);
        jobRaw    = await res.text();
      } catch {
        console.warn(`⚠️  Fetch failed for job URL: ${jobUrl}`);
        continue;
      }

      const chunks = splitIntoTokenChunks(jobRaw);
      const assembled = {};

      for (const chunk of chunks) {
        try {
          const out = await chatOnce(groq, MODEL, PROMPT_STAGE2(chunk), limiter);
          const obj = JSON.parse(out.startsWith('{') ? out : '{}');
          Object.assign(assembled, obj);           // merge partials
        } catch (err) {
          console.warn(`⚠️  Job parse chunk failed (${jobUrl})`, err);
        }
      }
      assembled.url        = jobUrl;
      assembled.company_id = c.id;
      assembled.seen_at    = new Date().toISOString();
      assembled.company_name = c.name;

      /* 5️⃣  UPSERT INTO SUPABASE */
      try {
        await sb.from('job_posts').upsert(assembled, {
          onConflict: ['company_id', 'url'],
          ignoreDuplicates: true,
        });
        newJobs.push(assembled);
        console.log(`   ➕  ${c.name}: ${assembled.title || '(title missing)'}`);
      } catch (e) {
        console.error(`❌  Insert error for ${jobUrl}`, e);
      }
    }

    /* 6️⃣  MARK COMPANY SCRAPED */
    await sb.from('companies').update({ last_scraped: new Date().toISOString() })
             .eq('id', c.id);
  }

  /* 7️⃣  EMAIL NOTIFICATION */
  if (newJobs.length) {
    const body = newJobs.map(j =>
      `${j.company_name}\n${j.title || ''}\n${j.url}\n${j.posted_date || ''}\n`
    ).join('\n');
    try {
      await mailer.sendMail({
        from: `"Job Monitor" <${process.env.EMAIL_USER}>`,
        to:   process.env.NOTIFY_EMAIL,
        subject: `🆕 ${newJobs.length} new job${newJobs.length > 1 ? 's' : ''}`,
        text: body,
      });
      console.log('📧  Email sent');
    } catch (e) { console.error('❌  Email error', e); }
  } else { console.log('ℹ️  No new jobs discovered'); }

  console.log('✅  Job monitor end:', new Date().toISOString());
}

/* ════════════════════════════════════════  EXECUTE  ═══════════════════════════════════════════ */

main().catch(err => {
  console.error('💥  Fatal error:', err);
  process.exit(1);
});
