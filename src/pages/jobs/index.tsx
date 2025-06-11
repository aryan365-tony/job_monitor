import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import styles from '@/styles/JobsPage.module.css';

type Job = {
  id: string;
  company_id: string;
  company_name: string;
  url: string;
  title: string | null;
  location: string | null;
  posted_date: string | null;
  summary: string | null;
  seen_at: string;
};

function isNew(postedDate: string | null): boolean {
  if (!postedDate) return false;
  const posted = new Date(postedDate);
  const now = new Date();
  const diffTime = now.getTime() - posted.getTime();
  const diffDays = diffTime / (1000 * 60 * 60 * 24);
  return diffDays <= 2;
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchJobs() {
      setLoading(true);
      const { data, error } = await supabase
        .from('job_posts')
        .select(`
          id,
          company_id,
          company_name,
          url,
          title,
          location,
          posted_date,
          summary,
          seen_at
        `);

      if (error) {
        console.error('Error fetching jobs:', error);
        setJobs([]);
      } else {
        const sorted = (data ?? []).sort((a, b) => {
          const dateA = new Date(a.posted_date || a.seen_at).getTime();
          const dateB = new Date(b.posted_date || b.seen_at).getTime();
          return dateB - dateA;
        });
        setJobs(sorted);
      }
      setLoading(false);
    }

    fetchJobs();
  }, []);

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Latest Job Opportunities</h1>

      {loading && (
        <p style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
          Loading job posts…
        </p>
      )}

      {!loading && jobs.length === 0 && (
        <p style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
          No job posts found.
        </p>
      )}

      <div className={styles.grid}>
        {jobs.map((job) => (
          <a
            key={job.id}
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.card}
          >
            <div className={styles.cardContent}>
              <h2 className={styles.cardTitle}>
                {job.title ?? 'Untitled Position'}
                {isNew(job.seen_at) && (
                  <span className={styles.newTag}>New</span>
                )}
              </h2>
              <p className={styles.cardCompany}>
                {job.company_name}
                {job.location && <> · {job.location}</>}
              </p>
              <p className={styles.cardSummary}>
                {job.summary ?? 'No description available.'}
              </p>
            </div>
            <div className={styles.cardFooter}>
              <span className={styles.postedDate}>
                {job.posted_date
                  ? `Posted: ${new Date(job.posted_date).toLocaleDateString()}`
                  : `Seen: ${new Date(job.seen_at).toLocaleDateString()}`}
              </span>
              <span className={styles.viewButton}>View</span>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
