import { useEffect, useState } from 'react';
import { supabase } from '@lib/supabase';
import type { Company } from '@/types';

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
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Companies</h1>
      <ul className="space-y-4">
        {companies.map((c) => (
          <li
            key={c.id}
            className="border p-4 rounded hover:shadow transition"
          >
            <a
              href={c.careers_url}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-lg font-semibold"
            >
              {c.name}
            </a>
            <p className="text-sm text-gray-600">{c.careers_url}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
