export interface Company {
  id: string;
  name: string;
  careers_url: string;
  selectors?: Record<string, any> | null;
  last_scraped: string | null;   // <— new field
}


export interface JobPost {
  id: string;
  company_id: string;
  url: string;
  title: string | null;
  location: string | null;
  posted_date: string | null;
  summary: string | null;
  seen_at: string;
}

export type Database = {
  public: {
    Tables: {
      companies: {
        Row: Company;
        Insert: Omit<Company, 'id' | 'last_scraped'> & { last_scraped?: string | null };
        Update: Partial<Omit<Company, 'id'>>;
      };
      job_posts: {
        Row: JobPost;
        Insert: Omit<JobPost, 'id' | 'seen_at'>;
        Update: Partial<Omit<JobPost, 'id'>>;
      };
    };
  };
};
