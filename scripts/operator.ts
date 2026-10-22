import { createClient } from '@supabase/supabase-js';
export function operator() {
  const url = process.env.SUPABASE_URL,
    key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    throw new Error('Set server-only SUPABASE_URL and SUPABASE_SECRET_KEY in the operator environment');
  if (
    !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) &&
    !/^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(url)
  )
    throw new Error('INVALID_SUPABASE_URL');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
