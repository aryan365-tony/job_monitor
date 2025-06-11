// pages/api/parse-jobs.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { Groq } from 'groq-sdk';
import { supabase } from '@/lib/supabase';
import * as cheerio from 'cheerio';
import nodemailer from 'nodemailer';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });
const MODEL = process.env.GROQ_MODEL!;
const CHUNK_SIZE = 25_000;

// Setup email transporter
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST!,
  port: Number(process.env.EMAIL_PORT),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER!,
    pass: process.env.EMAIL_PASS!,
  },
});

interface JobParsed {
  url: string;
  title?: string | null;
  location?: string | null;
  posted_date?: string | null;
  summary?: string | null;
}

function buildBatchPrompt(content: string) {
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

function cleanResponse(text: string): string {
  return text.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end('Method Not Allowed');
  }

  // Get all companies with optional api_url
  const { data: companies, error: compErr } = await supabase
    .from('companies')
    .select('id, name, careers_url, api_url, last_scraped');
  if (compErr) return res.status(500).json({ error: compErr.message });

  const cutoff = new Date(Date.now() - 3600_000).toISOString();
  const newJobs: Array<{ company: string; title: string | null; url: string; posted_date: string | null }> = [];

  for (const c of companies ?? []) {
    if (c.last_scraped && c.last_scraped >= cutoff) continue;

    // Fetch raw content
    let rawContent = '';
    if (c.api_url) {
      // fetch JSON from API
      try {
        const apiResp = await fetch(c.api_url);
        rawContent = JSON.stringify(await apiResp.json());
      } catch (e) {
        console.error(`API fetch failed for ${c.name}:`, e);
        continue;
      }
    } else {
      // fetch and filter HTML
      try {
        const htmlResp = await fetch(c.careers_url);
        const html = await htmlResp.text();
        const $ = cheerio.load(html);
        rawContent = $('body').html() || html;
      } catch (e) {
        console.error(`HTML fetch failed for ${c.name}:`, e);
        continue;
      }
    }

    // LLM parsing in chunks
    const parsedAccumulator: JobParsed[] = [];
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
        console.error(`LLM parse failed for ${c.name}:`, e);
        break;
      }
      const cleaned = cleanResponse(llmOutput);
      if (cleaned.startsWith('[')) {
        try {
          parsedAccumulator.push(...(JSON.parse(cleaned) as JobParsed[]));
        } catch {
          // skip parse errors
        }
      }
    }
    // Deduplicate
    const uniqueJobs = Array.from(
      parsedAccumulator.reduce((m, job) => {
        if (job.url) m.set(job.url, job);
        return m;
      }, new Map<string, JobParsed>()).values()
    );

    // Fetch seen URLs
    const { data: existing } = await supabase
      .from('job_posts')
      .select('url')
      .eq('company_id', c.id);
    const seen = new Set(existing?.map(r => r.url));

    // Insert new
    for (const job of uniqueJobs) {
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
        newJobs.push({
          company: c.name,
          title: ins.title,
          url: ins.url,
          posted_date: ins.posted_date,
        });
      }
    }

    // Update last_scraped
    await supabase
      .from('companies')
      .update({ last_scraped: new Date().toISOString() })
      .eq('id', c.id);
  }

  // Send email summary if any new jobs
  if (newJobs.length) {
    const details = newJobs.map(j =>
      `Company: ${j.company}\nTitle: ${j.title}\nURL: ${j.url}\nPosted: ${j.posted_date ?? 'Unknown'}\n`
    ).join('\n');
    await transporter.sendMail({
      from: `"Notifier" <${process.env.EMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL,
      subject: `New Jobs Found: ${newJobs.length}`,
      text: `New jobs:\n\n${details}`,
    });
  }

  res.status(200).json({ message: 'Done', newCount: newJobs.length });
}
