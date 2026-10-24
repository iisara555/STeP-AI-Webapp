import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from './host.ts';

const exchanges = new WeakMap<SupabaseClient, { code: string; result: Promise<void> }>();

// PKCE codes are single-use. React StrictMode can replay initialization effects.
export function exchangeCodeOnce(db: SupabaseClient, code: string) {
  const previous = exchanges.get(db);
  if (previous?.code === code) return previous.result;
  const result = db.auth.exchangeCodeForSession(code).then(({ error }) => {
    if (error) throw new ApiError('GOOGLE_LOGIN_FAILED');
  });
  exchanges.set(db, { code, result });
  return result;
}

export async function verifiedIdentity(db: SupabaseClient) {
  const { data, error } = await db.auth.getSession();
  if (error) throw new ApiError('UNAUTHENTICATED');
  if (!data.session) return '';
  // Browser storage only supplies the token. Auth confirms the current identity.
  const result = await db.auth.getUser();
  if (result.error || !result.data.user) throw new ApiError('UNAUTHENTICATED');
  return result.data.user.id;
}
