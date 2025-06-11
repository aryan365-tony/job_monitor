import { useEffect, useState } from 'react';
import { supabase } from '@lib/supabase';
import type { Company } from '@/types';
import styles from './IndexPage.module.css';

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);

  useEffect(() => {
    async function fetchCompanies() {
      const { data, error } = await supabase
        .from('companies')
        .select('*')
        .order('name');
      if (error) console.error(error);
      else setCompanies(data);
    }
    fetchCompanies();
  }, []);

  return (
    <div className={styles.container}>
      <h1 className={styles.heading}>Companies</h1>
      <div className={styles.list}>
        {companies.map((c) => (
          <div key={c.id} className={styles.companyCard}>
            <a
              href={c.careers_url}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.companyLink}
            >
              <div className={styles.companyName}>{c.name}</div>
            </a>
            <p className={styles.companyUrl}>{c.careers_url}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
