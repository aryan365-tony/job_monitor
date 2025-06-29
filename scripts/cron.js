import { Groq } from 'groq-sdk';
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import { encode } from 'gpt-3-encoder'; // ✅ NEW

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
    return (
      this.reqThisMinute < this.maxPerMinute &&
      this.reqToday < this.maxPerDay
    );
  }
  record() {
    this.reqThisMinute += 1;
    this.reqToday += 1;
  }
}

// --- Token Count & Chunking ---
function tokenCount(text) {
  return encode(text).length;
}

function splitContentByTokenLimit(content, maxTokensPerRequest, promptOverhead = 300) {
  const chunkTokenBudget = maxTokensPerRequest - promptOverhead;
  const chunkSize = chunkTokenBudget * 4; // approx 4 characters per token
  const chunks = [];
  let start = 0;
  while (start < content.length) {
    chunks.push(content.slice(start, start + chunkSize));
    start += chunkSize;
  }
  return chunks;
}

// --- Setup ---
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = process.env.GROQ_MODEL;
const MAX_REQUESTS_PER_MINUTE = 30;
const MAX_REQUESTS_PER_DAY = 14400;
const MAX_TOKENS_PER_REQUEST = 2000;
const PROMPT_OVERHEAD_TOKENS = 300;

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

function normalizeUrl(url) {
  try {
    const u = new URL(url.trim().toLowerCase());
    u.hash = '';
    u.searchParams.forEach((_, key) => {
      if (key.startsWith('utm_')) u.searchParams.delete(key);
    });
    u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return url.trim().toLowerCase();
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
\`\`\`
${content}
\`\`\`

JSON:
`;
}

function cleanResponse(text) {
  return text.replace(/``````/g, '').trim();
}

// --- Main Function ---
async function main() {
  console.log('🔔 Job start:', new Date().toISOString());

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );

  const { data: companies, error: compErr } = await supabase
    .from('companies')
    .select('id, name, careers_url, api_url, last_scraped');
  if (compErr) {
    console.error('❌ Error fetching companies:', compErr);
    process.exit(1);
  }
  console.log(`📦 Found ${companies.length} companies`);

  const cutoff = new Date(Date.now() - 3600_000).toISOString();
  const newJobs = [];
  const rateLimiter = new RateLimiter(MAX_REQUESTS_PER_MINUTE, MAX_REQUESTS_PER_DAY);

  for (const c of companies) {
    if (c.last_scraped && c.last_scraped >= cutoff) {
      console.log(`⏭️ Skipping ${c.name} (recent)`);
      continue;
    }

    let rawContent = '';
    try {
      if (c.api_url) {
        const apiResp = await fetch(c.api_url);
        rawContent = await apiResp.text();
      } else {
        const htmlResp = await fetch(c.careers_url);
        const html = await htmlResp.text();
        const $ = cheerio.load(html);
        rawContent = $('body').html() || html;
      }
    } catch (e) {
      console.error(`❌ Fetch failed for ${c.name}:`, e);
      continue;
    }

    const chunks = splitContentByTokenLimit(rawContent, MAX_TOKENS_PER_REQUEST, PROMPT_OVERHEAD_TOKENS);
    console.log(`🔍 Chunked ${rawContent.length} chars into ${chunks.length} chunks for ${c.name}`);
    
    const parsedAccumulator = [];

    for (const chunk of chunks) {
      const fullPrompt = buildBatchPrompt(chunk);
      const totalTokens = tokenCount(fullPrompt);

      if (totalTokens > MAX_TOKENS_PER_REQUEST) {
        console.warn(`⚠️ Skipping chunk for ${c.name} — ${totalTokens} tokens exceeds ${MAX_TOKENS_PER_REQUEST}`);
        continue;
      }

      while (!rateLimiter.canSend()) {
        console.log('⏳ Rate limit reached, waiting...');
        await new Promise(res => setTimeout(res, 1000));
      }
      rateLimiter.record();

      let llmOutput = '';
      try {
        const comp = await groq.chat.completions.create({
          model: MODEL,
          messages: [{ role: 'user', content: fullPrompt }],
        });
        llmOutput = comp.choices?.[0]?.message?.content || '';
      } catch (e) {
        console.error(`❌ LLM parse failed for ${c.name}:`, e);
        break;
      }

      const cleaned = cleanResponse(llmOutput);
      if (cleaned.startsWith('[')) {
        try {
          parsedAccumulator.push(...JSON.parse(cleaned));
        } catch {
          // Skip malformed JSON
        }
      }
    }

    const jobMap = new Map();
    for (const job of parsedAccumulator) {
      if (!job.url) continue;
      const normUrl = normalizeUrl(job.url);
      if (!jobMap.has(normUrl)) {
        jobMap.set(normUrl, { ...job, url: normUrl });
      }
    }
    const uniqueJobs = Array.from(jobMap.values());

    const { data: existing } = await supabase
      .from('job_posts')
      .select('url')
      .eq('company_id', c.id);
    const seen = new Set((existing || []).map(r => normalizeUrl(r.url)));

    const jobsToInsert = uniqueJobs.filter(job => !seen.has(job.url));

    if (jobsToInsert.length > 0) {
      const { error: insertError } = await supabase
        .from('job_posts')
        .insert(
          jobsToInsert.map(job => ({
            company_id: c.id,
            company_name: c.name,
            url: job.url,
            title: job.title ?? null,
            location: job.location ?? null,
            posted_date: job.posted_date ?? null,
            summary: job.summary ?? null,
            seen_at: new Date().toISOString(),
          }))
        );
      if (insertError) {
        console.error(`❌ Insert error for ${c.name}:`, insertError);
      } else {
        newJobs.push(...jobsToInsert.map(job => ({
          company: c.name,
          title: job.title,
          url: job.url,
          posted_date: job.posted_date,
        })));
        console.log(`   ➕ Inserted ${jobsToInsert.length} new jobs for ${c.name}`);
      }
    }

    await supabase
      .from('companies')
      .update({ last_scraped: new Date().toISOString() })
      .eq('id', c.id);
  }

  if (newJobs.length) {
    const details = newJobs
      .map(j => `Company: ${j.company}\nTitle: ${j.title}\nURL: ${j.url}\nPosted: ${j.posted_date ?? 'Unknown'}\n`)
      .join('\n');
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
