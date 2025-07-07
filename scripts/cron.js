import { Groq } from 'groq-sdk';
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import { encode, decode } from 'gpt-3-encoder';

// --- Rate Limiter ---
class RateLimiter {
  constructor(maxPerMinute, maxPerDay) {
    this.maxPerMinute = maxPerMinute;
    this.maxPerDay = maxPerDay;
    this.reqThisMinute = 0;
    this.reqToday = 0;
    this.minuteStart = Date.now();
    this.dayStart = Date.now();
  }
  resetMinute() {
    this.reqThisMinute = 0;
    this.minuteStart = Date.now();
  }
  resetDay() {
    this.reqToday = 0;
    this.dayStart = Date.now();
  }
  canSend() {
    const now = Date.now();
    if (now - this.minuteStart >= 60 * 1000) this.resetMinute();
    if (now - this.dayStart >= 24 * 60 * 60 * 1000) this.resetDay();
    return this.reqThisMinute < this.maxPerMinute && this.reqToday < this.maxPerDay;
  }
  record() {
    this.reqThisMinute++;
    this.reqToday++;
  }
}

function splitContentByTokenLimit(content, maxTokens, promptTokens = 300) {
  const tokens = encode(content);
  const chunks = [];
  let start = 0;
  const maxTokensPerChunk = maxTokens - promptTokens;

  while (start < tokens.length) {
    const chunkTokens = tokens.slice(start, start + maxTokensPerChunk);
    const chunkText = decode(chunkTokens);
    chunks.push(chunkText);
    start += maxTokensPerChunk;
  }

  return chunks;
}

// ✅ Stronger URL normalization
function normalizeUrl(raw) {
  try {
    const u = new URL(raw.trim());
    u.protocol = 'https:'; // force HTTPS
    u.hostname = u.hostname.replace(/^www\./i, '');
    u.search = ''; // drop all query params
    u.hash = '';   // drop fragments
    u.pathname = u.pathname.replace(/\/+$/, '') || '/'; // remove trailing slashes
    return `https://${u.hostname}${u.pathname}`.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

function buildBatchPrompt(content) {
  return `
You are an expert job parser. From the raw content below (HTML or JSON), extract *all* job postings.
For each posting, return exactly these keys:
- url
- title
- location
- posted_date (YYYY-MM-DD or null)
- summary

Return a JSON array of objects—nothing else.

Content:
\n\n\n${content}\n\n\nJSON:
  `;
}

function cleanResponse(text) {
  return text.replace(/``````/g, '').trim();
}

async function main() {
  console.log('🔔 Job start:', new Date().toISOString());

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const MODEL = process.env.GROQ_MODEL;
  const MAX_REQUESTS_PER_MINUTE = 30;
  const MAX_REQUESTS_PER_DAY = 14400;
  const MAX_TOKENS_PER_REQUEST = 2000;
  const PROMPT_OVERHEAD_TOKENS = 300;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );

  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT),
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const rateLimiter = new RateLimiter(MAX_REQUESTS_PER_MINUTE, MAX_REQUESTS_PER_DAY);
  const { data: companies, error: compErr } = await supabase.from('companies').select('*');
  if (compErr) {
    console.error('❌ Error fetching companies:', compErr);
    process.exit(1);
  }

  const cutoff = new Date(Date.now() - 3600_000).toISOString();
  const newJobs = [];

  for (const c of companies) {
    if (c.last_scraped && c.last_scraped >= cutoff) {
      console.log(`⏭️ Skipping ${c.name} (recent)`);
      continue;
    }

    let rawContent = '';
    try {
      const response = await fetch(c.api_url || c.careers_url);
      rawContent = await response.text();
    } catch (err) {
      console.error(`❌ Fetch failed for ${c.name}:`, err);
      continue;
    }

    const chunks = splitContentByTokenLimit(rawContent, MAX_TOKENS_PER_REQUEST, PROMPT_OVERHEAD_TOKENS);
    const parsedAccumulator = [];

    for (const chunk of chunks) {
      const fullPrompt = buildBatchPrompt(chunk);
      const totalTokens = encode(fullPrompt).length;
      if (totalTokens > MAX_TOKENS_PER_REQUEST) {
        console.warn(`⚠️ Skipping chunk for ${c.name} — ${totalTokens} tokens`);
        continue;
      }

      while (!rateLimiter.canSend()) {
        console.log('⏳ Rate limit hit, waiting...');
        await new Promise(r => setTimeout(r, 1000));
      }
      rateLimiter.record();

      try {
        const comp = await groq.chat.completions.create({
          model: MODEL,
          messages: [{ role: 'user', content: fullPrompt }],
        });
        const llmOutput = comp.choices?.[0]?.message?.content || '';
        const cleaned = cleanResponse(llmOutput);
        if (cleaned.startsWith('[')) parsedAccumulator.push(...JSON.parse(cleaned));
      } catch (err) {
        console.error(`❌ LLM parse failed for ${c.name}:`, err);
        break;
      }
    }

    const jobMap = new Map();
    for (const job of parsedAccumulator) {
      if (!job.url) continue;
      const normUrl = normalizeUrl(job.url);
      if (!jobMap.has(normUrl)) jobMap.set(normUrl, { ...job, url: normUrl });
    }

    const uniqueJobs = Array.from(jobMap.values());

    const { data: existing } = await supabase.from('job_posts').select('url').eq('company_id', c.id);
    const seen = new Set((existing || []).map(r => normalizeUrl(r.url)));
    const jobsToInsert = uniqueJobs.filter(job => !seen.has(job.url));

    if (jobsToInsert.length > 0) {
      const { error: insertError } = await supabase
        .from('job_posts')
        .upsert(
          jobsToInsert.map(job => ({
            company_id: c.id,
            company_name: c.name,
            url: job.url,
            title: job.title ?? null,
            location: job.location ?? null,
            posted_date: job.posted_date ?? null,
            summary: job.summary ?? null,
            seen_at: new Date().toISOString(),
          })),
          {
            onConflict: ['company_id', 'url'],
            ignoreDuplicates: true,
          }
        );

      if (!insertError) {
        newJobs.push(...jobsToInsert.map(job => ({
          company: c.name,
          title: job.title,
          url: job.url,
          posted_date: job.posted_date,
        })));
        console.log(`   ➕ Inserted ${jobsToInsert.length} new jobs for ${c.name}`);
      } else {
        console.error(`❌ Insert error for ${c.name}:`, insertError);
      }
    }

    await supabase.from('companies').update({ last_scraped: new Date().toISOString() }).eq('id', c.id);
  }

  if (newJobs.length) {
    const details = newJobs.map(j => `Company: ${j.company}\nTitle: ${j.title}\nURL: ${j.url}\nPosted: ${j.posted_date ?? 'Unknown'}\n`).join('\n');
    try {
      await transporter.sendMail({
        from: `"Notifier" <${process.env.EMAIL_USER}>`,
        to: process.env.NOTIFY_EMAIL,
        subject: `New Jobs Found: ${newJobs.length}`,
        text: `New jobs:\n\n${details}`,
      });
      console.log('✅ Email sent');
    } catch (e) {
      console.error('❌ Email send failed:', e);
    }
  } else {
    console.log('ℹ️ No new jobs — skipping email');
  }

  console.log('🔔 Job end:', new Date().toISOString());
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
