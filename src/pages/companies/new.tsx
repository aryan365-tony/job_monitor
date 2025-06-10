import { useState } from 'react';
import { useRouter } from 'next/router';
import { supabase } from '@/lib/supabase';

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

    const { data, error: supabaseError } = await supabase
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
      // Optionally redirect to jobs page or list companies
      // router.push('/jobs');
    }
  }

  return (
    <div className="max-w-md mx-auto mt-10 p-6 bg-white rounded shadow">
      <h1 className="text-2xl font-bold mb-6">Add New Company</h1>

      {error && <p className="text-red-600 mb-4">{error}</p>}
      {success && <p className="text-green-600 mb-4">Company added successfully!</p>}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="name" className="block font-medium mb-1">
            Company Name <span className="text-red-500">*</span>
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2"
            placeholder="e.g. OpenAI"
            required
          />
        </div>

        <div>
          <label htmlFor="careersUrl" className="block font-medium mb-1">
            Careers Page URL <span className="text-red-500">*</span>
          </label>
          <input
            id="careersUrl"
            type="url"
            value={careersUrl}
            onChange={(e) => setCareersUrl(e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2"
            placeholder="https://openai.com/careers"
            required
          />
        </div>

        <div>
          <label htmlFor="notes" className="block font-medium mb-1">
            Notes (Optional)
          </label>
          <textarea
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2"
            rows={3}
            placeholder="Additional info about the company"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-blue-600 text-white font-semibold py-2 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Adding...' : 'Add Company'}
        </button>
      </form>
    </div>
  );
}
