import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
export type Environment = (name: string) => string | undefined;
export const environment: Environment = (name) => {
  const deno = (globalThis as unknown as { Deno?: { env: { get(name: string): string | undefined } } }).Deno;
  return deno
    ? deno.env.get(name)
    : (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
        name
      ];
};
export function requireEnv(env: Environment, key: string) {
  const value = env(key);
  if (!value) throw new Error('SERVER_NOT_CONFIGURED');
  return value;
}
export function clients(env: Environment, authorization?: string) {
  const url = requireEnv(env, 'SUPABASE_URL');
  const secret = env('SUPABASE_SECRET_KEY') || env('SUPABASE_SERVICE_ROLE_KEY');
  if (!secret) throw new Error('SERVER_NOT_CONFIGURED');
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const service = createClient(url, secret, options);
  const user = createClient(url, env('SUPABASE_PUBLISHABLE_KEY') || env('SUPABASE_ANON_KEY') || secret, {
    ...options,
    global: { headers: { Authorization: authorization || '' } },
  });
  return { service, user };
}
export async function checked<T>(
  value: PromiseLike<{ data: T | null; error: { message: string; code?: string } | null }>,
): Promise<T> {
  const result = await value;
  if (result.error) {
    const code = result.error.message.match(
      /\b(?:ACCESS_DENIED|STORAGE_QUOTA|UPLOAD_PENDING|AI_NOT_CONFIGURED|AI_QUOTA|RUN_ACTIVE|VERSION_CONFLICT|REQUEST_CONFLICT|MEMBER_NOT_FOUND|GOOGLE_IDENTITY_REQUIRED|MEMBER_LIMIT|MEMORY_LIMIT|OPENROUTER_RATE_LIMIT)\b/,
    )?.[0];
    throw new Error(code || 'DATA_ERROR');
  }
  return result.data as T;
}
export interface Actor {
  service: SupabaseClient;
  userDb: SupabaseClient;
  user: User;
}
export async function authenticate(request: Request, env: Environment): Promise<Actor> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) throw new Error('UNAUTHENTICATED');
  const { service, user: userDb } = clients(env, authorization);
  const result = await userDb.auth.getUser(authorization.slice(7));
  if (result.error || !result.data.user) throw new Error('UNAUTHENTICATED');
  // Identity data comes from the Auth service, never from editable JWT user_metadata.
  if (!result.data.user.identities?.some((i) => i.provider === 'google'))
    throw new Error('GOOGLE_IDENTITY_REQUIRED');
  return { service, userDb, user: result.data.user };
}
export async function member(actor: Actor, t: string, admin = false) {
  const row = await checked<{ role: string; active: boolean } | null>(
    actor.userDb
      .from('tenant_members')
      .select('role,active')
      .eq('tenant_id', t)
      .eq('user_id', actor.user.id)
      .eq('active', true)
      .maybeSingle(),
  );
  if (!row || (admin && !['owner', 'admin'].includes(row.role))) throw new Error('ACCESS_DENIED');
  return row;
}
export function constantTimeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left),
    b = new TextEncoder().encode(right);
  let different = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) different |= (a[i] || 0) ^ (b[i] || 0);
  return different === 0;
}
export async function jsonBody(request: Request, maxBytes = 250000) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('INVALID_REQUEST');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error('REQUEST_TOO_LARGE');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('INVALID_REQUEST');
  }
}
export function safeCode(error: unknown) {
  const value = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z_]{2,60}$/.test(value) ? value : 'INTERNAL_ERROR';
}
export function cors(request: Request, env: Environment) {
  const origin = request.headers.get('origin');
  const expected = env('APP_ORIGIN');
  if (origin && origin !== expected) throw new Error('ORIGIN_DENIED');
  return {
    'Access-Control-Allow-Origin': expected || 'http://localhost:5173',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}
