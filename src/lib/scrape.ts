// src/lib/scrape.ts
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import type { Company } from '@/types';

export interface RawJob {
  url: string;
  snippet: string;       // HTML or text snippet to parse
}

// Default selectors if company.selectors is empty
const DEFAULT_SELECTORS = {
  container: 'a',         // find all links
  urlAttr: 'href',        // attribute for URL
  snippetSelector: null,  // if null, use outerHTML of <a>
};

export async function scrapeCompanyJobs(company: Company): Promise<RawJob[]> {
  const { careers_url, selectors } = company;
  const sel = { ...DEFAULT_SELECTORS, ...(selectors || {}) };

  const res = await fetch(careers_url);
  if (!res.ok) throw new Error(`Failed to fetch ${careers_url}: ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  const jobs: RawJob[] = [];

  // Find each job element
  $(sel.container).each((_, el) => {
    const elem = $(el);
    let url = elem.attr(sel.urlAttr);
    if (!url) return;

    // Resolve relative URLs
    if (url.startsWith('/')) {
      const base = new URL(careers_url);
      url = base.origin + url;
    }

    // Extract snippet HTML/text to feed into LLM
    const snippet = sel.snippetSelector
      ? elem.find(sel.snippetSelector).html() || ''
      : $.html(elem);

    jobs.push({ url, snippet });
  });

  // Deduplicate by URL
  const unique: Record<string, RawJob> = {};
  for (const job of jobs) {
    unique[job.url] = job;
  }
  return Object.values(unique);
}
