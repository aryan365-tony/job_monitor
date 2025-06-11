import { useState } from 'react';
import { useRouter } from 'next/router';
import { supabase } from '@/lib/supabase';
import styles from './NewPage.module.css';

export default function AddCompanyPage() {
  const router = useRouter();

  const [name, setName] = useState('');
  const [careersUrl, setCareersUrl] = useState('');
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
      .insert([{ name: name.trim(), careers_url: careersUrl.trim(), notes: notes.trim() }]);

    setLoading(false);

    if (supabaseError) {
      setError(supabaseError.message);
    } else {
      setSuccess(true);
      setName('');
      setCareersUrl('');
      setNotes('');
    }
  }

  return (
    <div className={styles.container}>
      <form onSubmit={handleSubmit} className={styles.formWrapper}>
        <h1 className={styles.heading}>Add New Company</h1>

        {error && <p className={styles.error}>{error}</p>}
        {success && <p className={styles.success}>Company added successfully!</p>}

        <label htmlFor="name" className={styles.label}>
          Company Name <span style={{ color: '#ff6b6b' }}>*</span>
        </label>
        <input
          id="name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={styles.input}
          placeholder="e.g. OpenAI"
          required
        />

        <label htmlFor="careersUrl" className={styles.label}>
          Careers Page URL <span style={{ color: '#ff6b6b' }}>*</span>
        </label>
        <input
          id="careersUrl"
          type="url"
          value={careersUrl}
          onChange={(e) => setCareersUrl(e.target.value)}
          className={styles.input}
          placeholder="https://openai.com/careers"
          required
        />

        <label htmlFor="notes" className={styles.label}>Notes (Optional)</label>
        <textarea
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className={styles.textarea}
          rows={3}
          placeholder="Additional info about the company"
        />

        <button
          type="submit"
          disabled={loading}
          className={styles.button}
        >
          {loading ? 'Adding...' : 'Add Company'}
        </button>
      </form>
    </div>
  );
}
