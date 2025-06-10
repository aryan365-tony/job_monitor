// src/pages/api/parse-jobs.ts

import type { NextApiRequest, NextApiResponse } from 'next';
import OpenAI from 'openai';
import { supabase } from '@/lib/supabase';
import { scrapeCompanyJobs, RawJob } from '@/lib/scrape';

const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

// Build prompt for a single raw snippet
function buildPrompt(rawHtml: string) {
  return `
You are an expert job parser. Extract these fields from the snippet:
- title
- location
- posted_date (YYYY-MM-DD)
- summary

Return a JSON object with exactly these keys.

Snippet:
"""
${rawHtml}
"""

JSON:
`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 1) Only allow GET (for cron)
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 2) Determine cutoff for scraping (e.g. 1 hour ago)
    const cutoff = new Date(Date.now() - 3600_000).toISOString();

    // 3) Fetch companies due for scraping (never or >1h ago)
    const { data: companies, error: compErr } = await supabase
      .from('companies')
      .select('id, name, careers_url, selectors, last_scraped')
      .or(`last_scraped.is.null,last_scraped.lt.${cutoff}`);
    if (compErr) throw compErr;
    if (!companies || companies.length === 0) {
      return res.status(200).json({ message: 'No companies due for scraping' });
    }

    const results: Array<{ company: string; jobId: string }> = [];

    // 4) Loop through each company
    for (const company of companies) {
      let rawJobs: RawJob[];
      try {
        rawJobs = await scrapeCompanyJobs(company);
      } catch (e) {
        console.error(`Failed to scrape ${company.name}:`, e);
        continue;
      }
      if (rawJobs.length === 0) {
        // Update last_scraped even if no jobs found
        await supabase
          .from('companies')
          .update({ last_scraped: new Date().toISOString() })
          .eq('id', company.id);
        continue;
      }

      // 5) Fetch existing URLs for this company in one batch
      const { data: existingRows } = await supabase
        .from('job_posts')
        .select('url')
        .eq('company_id', company.id);
      const seen = new Set(existingRows?.map((r) => r.url));

      // 6) Filter only new URLs
      const newJobs = rawJobs.filter((job) => !seen.has(job.url));
      if (newJobs.length === 0) {
        // Nothing new—update last_scraped and continue
        await supabase
          .from('companies')
          .update({ last_scraped: new Date().toISOString() })
          .eq('id', company.id);
        continue;
      }

      // 7) Parse & insert each new job
      for (const { url, snippet } of newJobs) {
        const prompt = buildPrompt(snippet);

        let parsed: any;
        try {
          const completion = await openai.chat.completions.create({
            model: 'deepseek/deepseek-r1-0528:free',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 500,
            temperature: 0,
          });
          const content = completion.choices[0].message?.content;
          parsed = content ? JSON.parse(content) : null;
        } catch (err) {
          console.warn(`LLM parse failed for ${url}:`, err);
          continue;
        }

        if (!parsed) continue;

        const { data: inserted, error: insertErr } = await supabase
          .from('job_posts')
          .insert({
            company_id: company.id,
            url,
            title: parsed.title ?? null,
            location: parsed.location ?? null,
            posted_date: parsed.posted_date ?? null,
            summary: parsed.summary ?? null,
            seen_at: new Date().toISOString(),
          })
          .select('id')
          .single();

        if (insertErr) {
          console.error('Insert error:', insertErr);
          continue;
        }

        results.push({ company: company.name, jobId: inserted.id });
      }

      // 8) Update last_scraped timestamp
      await supabase
        .from('companies')
        .update({ last_scraped: new Date().toISOString() })
        .eq('id', company.id);
    }

    return res.status(200).json({ message: 'Scrape cycle complete', results });
  } catch (err: any) {
    console.error('Parse-jobs API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
