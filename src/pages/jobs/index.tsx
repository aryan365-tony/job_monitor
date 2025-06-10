// src/pages/jobs/index.tsx
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Company {
  id: string;
  name: string;
  careers_url: string;
  selectors?: Record<string, any>;
}

interface JobPost {
  id: string;
  company_id: string;
  url: string;
  title: string | null;
  location: string | null;
  posted_date: string | null;
  summary: string | null;
  seen_at: string | null;
  companies?: Company[]; // Supabase returns as array
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobPost[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchJobs() {
      setLoading(true);
      const { data, error } = await supabase
        .from('job_posts')
        .select('*, companies(*)')
        .order('posted_date', { ascending: false });

      if (error) {
        console.error('Error fetching jobs:', error);
        setJobs([]);
      } else if (data) {
        setJobs(data);
      }
      setLoading(false);
    }

    fetchJobs();
  }, []);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Job Updates</h1>

      {loading && <p>Loading jobs...</p>}

      {!loading && jobs.length === 0 && <p>No jobs found.</p>}

      <div className="space-y-6">
        {jobs.map((job) => {
          // companies is an array with one company due to relation
          const company = job.companies?.[0];
          return (
            <div
              key={job.id}
              className="border rounded p-4 shadow hover:shadow-lg transition"
            >
              <h2 className="text-xl font-semibold">{job.title || 'No title'}</h2>
              <p className="text-sm text-gray-600">
                <strong>Company:</strong> {company?.name || 'Unknown'}
              </p>
              <p className="text-sm text-gray-600">
                <strong>Location:</strong> {job.location || 'Not specified'}
              </p>
              <p className="text-sm text-gray-600">
                <strong>Posted:</strong> {job.posted_date || 'Unknown'}
              </p>
              <p className="mt-2">{job.summary || 'No description available.'}</p>
              {job.url && (
                <a
                  href={job.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline mt-2 block"
                >
                  View Job Post
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
