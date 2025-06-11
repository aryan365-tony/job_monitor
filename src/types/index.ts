// src/types/index.ts

export interface Company {
  id: string
  name: string
  careers_url: string
  api_url?: string | null        // optional API endpoint
  selectors?: Record<string, any> | null  // optional CSS selectors override
  notes?: string | null
  last_scraped?: string | null
}

export interface JobPost {
  id: string
  company_id: string
  company_name: string
  url: string
  title: string | null
  location: string | null
  posted_date: string | null
  summary: string | null
  seen_at: string
}

export type Database = {
  public: {
    Tables: {
      companies: {
        Row: Company
        Insert: Omit<Company, 'id'>
        Update: Partial<Omit<Company, 'id'>>
      }
      job_posts: {
        Row: JobPost
        Insert: Omit<JobPost, 'id'>
        Update: Partial<Omit<JobPost, 'id'>>
      }
    }
  }
}
