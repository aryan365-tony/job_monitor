import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!url || !anonKey) {
  throw new Error('Both NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set');
}

export const supabase: SupabaseClient<Database> =
  createClient<Database>(url, anonKey);
