// scripts/cron.js
import { Groq } from 'groq-sdk';
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = process.env.GROQ_MODEL;
const CHUNK_SIZE = 15_000;

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Loosened normalization: only lowercases and trims
function normalizeUrlLoosely(url) {
  return url ? url.trim().toLowerCase() : '';
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

async function main() {
  console.log('🔔 Job start:', new Date().toISOString());

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );

  // 1. Fetch companies
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

  for (const c of companies) {
    if (c.last_scraped && c.last_scraped >= cutoff) {
      console.log(`⏭️ Skipping ${c.name} (recent)`);
      continue;
    }

    // 2. Fetch raw content
    let rawContent = '';
    try {
      if (c.api_url) {
        const apiResp = await fetch(c.api_url);
        rawContent = JSON.stringify(await apiResp.json());
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

    // 3. Parse via LLM in chunks
    const parsedAccumulator = [];
    for (let i = 0; i < rawContent.length; i += CHUNK_SIZE) {
      const chunk = rawContent.slice(i, i + CHUNK_SIZE);
      let llmOutput = '';
      try {
        const comp = await groq.chat.completions.create({
          model: MODEL,
          messages: [{ role: 'user', content: buildBatchPrompt(chunk) }],
        });
        llmOutput = comp.choices[0]?.message?.content || '';
      } catch (e) {
        console.error(`❌ LLM parse failed for ${c.name}:`, e);
        break;
      }
      const cleaned = cleanResponse(llmOutput);
      if (cleaned.startsWith('[')) {
        try {
          parsedAccumulator.push(...JSON.parse(cleaned));
        } catch {
          // ignore JSON errors
        }
      }
    }
    console.log(`🔎 Parsed ${parsedAccumulator.length} jobs for ${c.name}`);

    // 4. Loosened deduplication by normalized URL (lowercase + trim only)
    const jobMap = new Map();
    for (const job of parsedAccumulator) {
      if (!job.url) continue;
      const normUrl = normalizeUrlLoosely(job.url);
      if (!jobMap.has(normUrl)) {
        jobMap.set(normUrl, { ...job, url: normUrl });
      }
    }
    const uniqueJobs = Array.from(jobMap.values());
    console.log(`🗂️ ${uniqueJobs.length} unique jobs for ${c.name} after deduplication`);

    // 5. Fetch and normalize existing URLs
    const { data: existing } = await supabase
      .from('job_posts')
      .select('url')
      .eq('company_id', c.id);
    const seen = new Set((existing || []).map(r => normalizeUrlLoosely(r.url)));

    // 6. Insert new jobs, handling unique constraint
    for (const job of uniqueJobs) {
      const normUrl = job.url;
      if (!normUrl || seen.has(normUrl)) continue;
      try {
        const { data: ins, error: ie } = await supabase
          .from('job_posts')
          .insert({
            company_id:   c.id,
            company_name: c.name,
            url:          normUrl,
            title:        job.title ?? null,
            location:     job.location ?? null,
            posted_date:  job.posted_date ?? null,
            summary:      job.summary ?? null,
            seen_at:      new Date().toISOString(),
          })
          .select('title, url, posted_date')
          .single();
        if (!ie && ins) {
          newJobs.push({
            company:     c.name,
            title:       ins.title,
            url:         ins.url,
            posted_date: ins.posted_date,
          });
          seen.add(normUrl); // Add to set to prevent duplicates in this run
          console.log(`   ➕ New job: ${ins.title}`);
        } else if (ie && ie.code === '23505') {
          // Unique constraint violation, ignore
          continue;
        } else if (ie) {
          // Other errors
          console.error(`Insert error for ${c.name}:`, ie);
        }
      } catch (e) {
        if (e.code === '23505') {
          continue;
        }
        console.error(`Insert exception for ${c.name}:`, e);
      }
    }

    // 7. Update last_scraped
    await supabase
      .from('companies')
      .update({ last_scraped: new Date().toISOString() })
      .eq('id', c.id);
  }

  // 8. Send summary email
  if (newJobs.length) {
    console.log(`🆕 Sending email for ${newJobs.length} new jobs`);
    const details = newJobs
      .map(j =>
        `Company: ${j.company}\nTitle: ${j.title}\nURL: ${j.url}\nPosted: ${
          j.posted_date ?? 'Unknown'
        }\n`
      )
      .join('\n');
    try {
      await transporter.sendMail({
        from:    `"Notifier" <${process.env.EMAIL_USER}>`,
        to:      process.env.NOTIFY_EMAIL,
        subject: `New Jobs Found: ${newJobs.length}`,
        text:    `New jobs:\n\n${details}`,
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
