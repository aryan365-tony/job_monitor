// pages/companies/new.tsx
import { useState } from 'react';
import { useRouter } from 'next/router';
import { supabase } from '@/lib/supabase';
import styles from '@/styles/AddCompanyPage.module.css';

export default function AddCompanyPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [careersUrl, setCareersUrl] = useState('');
  const [apiUrl, setApiUrl] = useState('');      // optional API URL
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (!name.trim() || !careersUrl.trim()) {
      setError('Please fill in both company name and careers URL.');
      return;
    }

    setLoading(true);
    const { error: supabaseError } = await supabase
      .from('companies')
      .insert([{
        name: name.trim(),
        careers_url: careersUrl.trim(),
        api_url: apiUrl.trim() || null,
        notes: notes.trim() || null,
      }]);
    setLoading(false);

    if (supabaseError) {
      setError(supabaseError.message);
    } else {
      setSuccess(true);
      setName(''); setCareersUrl(''); setApiUrl(''); setNotes('');
      // optional redirect after delay:
      // setTimeout(() => router.push('/companies'), 1500);
    }
  }

  return (
    <div className={styles.container}>
      <form onSubmit={handleSubmit} className={styles.formWrapper}>
        <h1 className={styles.heading}>Add New Company</h1>
        {error && <p className={styles.error}>{error}</p>}
        {success && <p className={styles.success}>Company added successfully!</p>}

        <div className={styles.formGroup}>
          <label htmlFor="name" className={styles.label}>
            Company Name <span className={styles.required}>*</span>
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className={styles.input}
            placeholder="e.g. OpenAI"
            required
          />
        </div>

        <div className={styles.formGroup}>
          <label htmlFor="careersUrl" className={styles.label}>
            Careers Page URL <span className={styles.required}>*</span>
          </label>
          <input
            id="careersUrl"
            type="url"
            value={careersUrl}
            onChange={e => setCareersUrl(e.target.value)}
            className={styles.input}
            placeholder="https://company.com/careers"
            required
          />
        </div>

        <div className={styles.formGroup}>
          <label htmlFor="apiUrl" className={styles.label}>
            Jobs API URL (optional)
          </label>
          <input
            id="apiUrl"
            type="url"
            value={apiUrl}
            onChange={e => setApiUrl(e.target.value)}
            className={styles.input}
            placeholder="https://company.com/api/jobs"
          />
        </div>

        <div className={styles.formGroup}>
          <label htmlFor="notes" className={styles.label}>Notes (optional)</label>
          <textarea
            id="notes"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            className={styles.textarea}
            rows={3}
            placeholder="Any extra info"
          />
        </div>

        <button type="submit" disabled={loading} className={styles.btnPrimary}>
          {loading ? 'Adding…' : 'Add Company'}
        </button>
      </form>
    </div>
  );
}
