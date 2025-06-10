import type { NextApiRequest, NextApiResponse } from 'next';
import Groq from 'groq-sdk';
import { supabase } from '@/lib/supabase';
import * as cheerio from 'cheerio';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });
const MODEL = process.env.GROQ_MODEL!;

// Define a type for the parsed job objects
interface JobParsed {
  url: string;
  title?: string | null;
  location?: string | null;
  posted_date?: string | null;
  summary?: string | null;
}

// Approximate chunk size to stay within token limits
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
    const cutoff = new Date(Date.now() - 3600_000).toISOString();
    const { data: companies, error: compErr } = await supabase
      .from('companies')
      .select('id, name, careers_url, last_scraped')
      .or(`last_scraped.is.null,last_scraped.lt.${cutoff}`);
    if (compErr) throw compErr;
    if (!companies?.length) {
      return res.status(200).json({ message: 'No companies due for scraping' });
    }

    const results: Array<{ company: string; jobId: string }> = [];

    for (const company of companies) {
      let html: string;
      try {
        const resp = await fetch(company.careers_url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const rawHtml = await resp.text();

        // Filter with Cheerio
        const $ = cheerio.load(rawHtml);
        const bodyHtml = $('body').html() || '';
        html = bodyHtml;
      } catch (e) {
        console.error(`Fetch failed for ${company.name}:`, e);
        continue;
      }

      // Slice HTML into manageable chunks
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
          console.error(`GROQ AI parse failed for ${company.name} chunk at ${offset}:`, e);
          break;
        }

        try {
          const parsedChunk = JSON.parse(cleanJSON(raw)) as JobParsed[];
          if (Array.isArray(parsedChunk)) {
            jobsAccumulator.push(...parsedChunk);
          }
        } catch (e) {
          console.warn(`JSON parse failed for chunk at ${offset}:`, e);
        }
      }

      // Deduplicate within the batch by URL
      const uniqueJobs = Array.from(
        jobsAccumulator.reduce((map, job) => {
          if (job.url) map.set(job.url, job);
          return map;
        }, new Map<string, JobParsed>()).values()
      );

      // Fetch existing URLs for this company
      const { data: existing } = await supabase
        .from('job_posts')
        .select('url')
        .eq('company_id', company.id);
      const seen = new Set(existing?.map((r) => r.url));

      // Insert only truly new jobs
      for (const job of uniqueJobs) {
        if (!job.url || seen.has(job.url)) continue;
        try {
          const { data: inserted, error: insertErr } = await supabase
            .from('job_posts')
            .insert({
              company_id: company.id,
              url: job.url,
              title: job.title ?? null,
              location: job.location ?? null,
              posted_date: job.posted_date ?? null,
              summary: job.summary ?? null,
              seen_at: new Date().toISOString(),
            })
            .select('id')
            .single();
          if (insertErr) throw insertErr;
          results.push({ company: company.name, jobId: inserted.id });
        } catch (e) {
          console.error(`Insert failed for ${job.url}:`, e);
        }
      }

      // Update last_scraped timestamp
      await supabase
        .from('companies')
        .update({ last_scraped: new Date().toISOString() })
        .eq('id', company.id);
    }

    return res.status(200).json({ message: 'Batch scrape complete', results });
  } catch (err: any) {
    console.error('parse-jobs error:', err);
    return res.status(500).json({ error: err.message });
  }
}
