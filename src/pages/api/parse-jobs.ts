// src/pages/api/parse-jobs.ts

import type { NextApiRequest, NextApiResponse } from 'next';
import OpenAI from 'openai';
import { supabase } from '@/lib/supabase';
import { scrapeCompanyJobs, RawJob } from '@/lib/scrape';

const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

function buildPrompt(rawHtml: string) {
  return `
You are an expert job parser. Extract these fields from the snippet:
- title
- location
- posted_date (YYYY-MM-DD)
- summary

Return a JSON object with exactly these keys—nothing else.
Do not wrap in Markdown or backticks.

Snippet:
"""
${rawHtml}
"""

JSON:
`;
}

/**
 * Remove markdown fences and stray backticks from an LLM response
 */
function cleanLLMResponse(text: string): string {
  // Remove ```json and ``` fences
  let cleaned = text
    .replace(/```json\s*/g, '')
    .replace(/```/g, '')
    .trim();
  // Also remove any leading/trailing backticks
  cleaned = cleaned.replace(/^`+/, '').replace(/`+$/, '').trim();
  return cleaned;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const cutoff = new Date(Date.now() - 3600_000).toISOString();
    const { data: companies, error: compErr } = await supabase
      .from('companies')
      .select('id, name, careers_url, selectors, last_scraped')
      .or(`last_scraped.is.null,last_scraped.lt.${cutoff}`);
    if (compErr) throw compErr;
    if (!companies?.length) {
      return res.status(200).json({ message: 'No companies due for scraping' });
    }

    const results: Array<{ company: string; jobId: string }> = [];

    for (const company of companies) {
      let rawJobs: RawJob[];
      try {
        rawJobs = await scrapeCompanyJobs(company);
      } catch (e) {
        console.error(`Failed to scrape ${company.name}:`, e);
        continue;
      }

      if (!rawJobs.length) {
        await supabase
          .from('companies')
          .update({ last_scraped: new Date().toISOString() })
          .eq('id', company.id);
        continue;
      }

      const { data: existingRows } = await supabase
        .from('job_posts')
        .select('url')
        .eq('company_id', company.id);
      const seen = new Set(existingRows?.map((r) => r.url));

      const newJobs = rawJobs.filter((job) => !seen.has(job.url));
      if (!newJobs.length) {
        await supabase
          .from('companies')
          .update({ last_scraped: new Date().toISOString() })
          .eq('id', company.id);
        continue;
      }

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
          let content = completion.choices[0].message?.content;
          if (!content) throw new Error('Empty LLM response');

          // **CLEAN** the response to valid JSON
          content = cleanLLMResponse(content);

          parsed = JSON.parse(content);
        } catch (err) {
          console.warn(`LLM parse failed for ${url}:`, err);
          continue;
        }

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
