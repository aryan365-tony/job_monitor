import type { NextApiRequest, NextApiResponse } from 'next';
import Groq from 'groq-sdk';
import { supabase } from '@/lib/supabase';
import * as cheerio from 'cheerio';

const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

// Build prompt for a single raw snippet
function buildPrompt(rawHtml: string) {
  return `
You are an expert web scraper and JSON formatter. From this HTML snippet, extract *all* job postings.
For each, return exactly these keys:
- url
- title
- location
- posted_date (YYYY-MM-DD or null)
- summary

Return a JSON object with exactly these keys.

HTML Snippet:
\`\`\`
${htmlChunk}
\`\`\`

JSON:
`;
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
      const seen = new Set(existing?.map((r) => r.url));

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

    return res.status(200).json({ message: 'Batch scrape complete', results });
  } catch (err: any) {
    console.error('parse-jobs error:', err);
    return res.status(500).json({ error: err.message });
  }
}
