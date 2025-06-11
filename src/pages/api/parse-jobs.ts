// src/pages/api/parse-jobs.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { Groq } from 'groq-sdk';
import { supabase } from '@/lib/supabase';
import * as cheerio from 'cheerio';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });
const MODEL = process.env.GROQ_MODEL!;

interface JobParsed {
  url: string;
  title?: string | null;
  location?: string | null;
  posted_date?: string | null;
  summary?: string | null;
}

const CHUNK_SIZE = 25_000;

function buildBatchPrompt(htmlChunk: string) {
  return `
You are an expert web scraper and JSON formatter. From this HTML snippet, extract *all* job postings.
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
    const results: Array<{ company: string; jobId: string }> = [];

    for (const c of companies) {
      // 2) Get count of existing jobs for this company
      const { count } = await supabase
        .from('job_posts')
        .select('id', { head: true, count: 'exact' })
        .eq('company_id', c.id);
      const hasJobs = (count ?? 0) > 0;

      // Skip if it already has jobs and was scraped recently
      if (hasJobs && c.last_scraped && c.last_scraped >= cutoff) {
        continue;
      }

      // 3) Fetch and filter the page HTML
      let html: string;
      try {
        const resp = await fetch(c.careers_url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const rawHtml = await resp.text();
        const $ = cheerio.load(rawHtml);
        html = $('body').html() || '';
      } catch (e) {
        console.error(`Fetch failed for ${c.name}:`, e);
        continue;
      }

      // 4) Chunk + LLM parse
      const jobsAccumulator: JobParsed[] = [];
      for (let offset = 0; offset < html.length; offset += CHUNK_SIZE) {
        const chunk = html.slice(offset, offset + CHUNK_SIZE);
        let raw: string;
        try {
          const completion = await groq.chat.completions.create({
            model: MODEL,
            messages: [{ role: 'user', content: buildBatchPrompt(chunk) }],
          });
          raw = completion.choices[0]?.message?.content || '';
        } catch (e) {
          console.error(`GROQ AI parse failed for ${c.name} chunk at ${offset}:`, e);
          break;
        }

        const cleaned = cleanJSON(raw);
        if (cleaned.startsWith('[')) {
          try {
            const parsed = JSON.parse(cleaned) as JobParsed[];
            if (Array.isArray(parsed)) jobsAccumulator.push(...parsed);
          } catch (e) {
            console.warn(`JSON parse failed for chunk at ${offset}:`, e);
          }
        }
      }

      // 5) Deduplicate within the batch
      const uniqueJobs = Array.from(
        jobsAccumulator.reduce((map, job) => {
          if (job.url) map.set(job.url, job);
          return map;
        }, new Map<string, JobParsed>()).values()
      );

      // 6) Fetch existing URLs to filter out inserts
      const { data: existing } = await supabase
        .from('job_posts')
        .select('url')
        .eq('company_id', c.id);
      const seen = new Set(existing?.map((r) => r.url));

      // 7) Insert only new postings
      for (const job of uniqueJobs) {
        if (!job.url || seen.has(job.url)) continue;
        try {
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
            .select('id')
            .single();
          if (ie) throw ie;
          results.push({ company: c.name, jobId: ins.id });
        } catch (e) {
          console.error(`Insert failed for ${job.url}:`, e);
        }
      }

      // 8) Update last_scraped
      await supabase
        .from('companies')
        .update({ last_scraped: new Date().toISOString() })
        .eq('id', c.id);
    }

    return res.status(200).json({ message: 'Batch scrape complete', results });
  } catch (err: any) {
    console.error('parse-jobs error:', err);
    return res.status(500).json({ error: err.message });
  }
}
