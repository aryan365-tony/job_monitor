// pages/api/parse-jobs.ts

import type { NextApiRequest, NextApiResponse } from 'next';
import { Groq } from 'groq-sdk';
import { supabase } from '@/lib/supabase';
import * as cheerio from 'cheerio';
import nodemailer from 'nodemailer';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });
const MODEL = process.env.GROQ_MODEL!;

// Configure Nodemailer transporter
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

interface JobParsed {
  url: string;
  title?: string | null;
  location?: string | null;
  posted_date?: string | null;
  summary?: string | null;
}

// chunk size to stay under token limit
const CHUNK_SIZE = 25_000;

function buildBatchPrompt(htmlChunk: string) {
  return `
You are an expert job scraper and JSON formatter. From this HTML snippet, extract *all* job postings.
For each, return exactly these keys:
- url
- title
- location
- posted_date (YYYY-MM-DD or null)
- summary

Return a JSON _array_ of such objects—nothing else.

HTML Snippet:
\`\`\`
${htmlChunk}
\`\`\`

JSON:
`;
}

function cleanJSON(text: string): string {
  return text
    .replace(/```(?:json)?/g, '')
    .replace(/```/g, '')
    .replace(/^`+/, '')
    .replace(/`+$/, '')
    .trim();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 1) Fetch all companies
    const { data: companies, error: compErr } = await supabase
      .from('companies')
      .select('id, name, careers_url, last_scraped');
    if (compErr) throw compErr;
    if (!companies?.length) {
      return res.status(200).json({ message: 'No companies found' });
    }

    const cutoff = new Date(Date.now() - 3600_000).toISOString();
    const insertedJobs: Array<{
      company: string;
      title: string | null;
      url: string;
      posted_date: string | null;
    }> = [];

    for (const c of companies) {
      // count existing
      const { count } = await supabase
        .from('job_posts')
        .select('id', { head: true, count: 'exact' })
        .eq('company_id', c.id);
      const hasJobs = (count ?? 0) > 0;
      if (hasJobs && c.last_scraped && c.last_scraped >= cutoff) continue;

      // fetch and filter
      let html: string;
      try {
        const resp = await fetch(c.careers_url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const rawHtml = await resp.text();
        const $ = cheerio.load(rawHtml);
        html = $('body').html() || '';
      } catch {
        continue;
      }

      // chunk & parse
      const jobsAccumulator: JobParsed[] = [];
      for (let offset = 0; offset < html.length; offset += CHUNK_SIZE) {
        const chunk = html.slice(offset, offset + CHUNK_SIZE);
        let raw: string;
        try {
          const comp = await groq.chat.completions.create({
            model: MODEL,
            messages: [{ role: 'user', content: buildBatchPrompt(chunk) }],
          });
          raw = comp.choices[0]?.message?.content || '';
        } catch {
          break;
        }
        const cleaned = cleanJSON(raw);
        if (cleaned.startsWith('[')) {
          try {
            const parsed = JSON.parse(cleaned) as JobParsed[];
            jobsAccumulator.push(...parsed);
          } catch {
            /* skip */
          }
        }
      }

      // dedupe
      const unique = Array.from(
        jobsAccumulator.reduce((m, job) => {
          if (job.url) m.set(job.url, job);
          return m;
        }, new Map<string, JobParsed>()).values()
      );

      // existing URLs
      const { data: existing } = await supabase
        .from('job_posts')
        .select('url')
        .eq('company_id', c.id);
      const seen = new Set(existing?.map((r) => r.url));

      // insert new
      for (const job of unique) {
        if (!job.url || seen.has(job.url)) continue;
        const { data: ins, error: ie } = await supabase
          .from('job_posts')
          .insert({
            company_id: c.id,
            company_name: c.name,
            url: job.url,
            title: job.title ?? null,
            location: job.location ?? null,
            posted_date: job.posted_date ?? null,
            summary: job.summary ?? null,
            seen_at: new Date().toISOString(),
          })
          .select('title, url, posted_date')
          .single();
        if (!ie && ins) {
          insertedJobs.push({
            company: c.name,
            title: ins.title,
            url: ins.url,
            posted_date: ins.posted_date,
          });
        }
      }

      // update last_scraped
      await supabase
        .from('companies')
        .update({ last_scraped: new Date().toISOString() })
        .eq('id', c.id);
    }

    // 2) Send email if new jobs found
    if (insertedJobs.length > 0) {
      const lines = insertedJobs.map(
        (j) =>
          `Company: ${j.company}\nTitle: ${j.title}\nURL: ${j.url}\nPosted: ${
            j.posted_date ?? 'Unknown'
          }\n`
      ).join('\n');

      await transporter.sendMail({
        from: `"Notifier" <${process.env.EMAIL_USER}>`,
        to: process.env.NOTIFY_EMAIL,
        subject: `New Jobs Found: ${insertedJobs.length}`,
        text: `The following new jobs were found:\n\n${lines}`,
      });
    }

    return res.status(200).json({ message: 'Done', newCount: insertedJobs.length });
  } catch (err: any) {
    console.error('parse-jobs error:', err);
    return res.status(500).json({ error: err.message });
  }
}
