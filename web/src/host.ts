import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Snapshot } from '../../packages/harness-core/src/contracts.ts';
import { returnPath, returnPathKey } from './routes.ts';
export class ApiError extends Error {
  constructor(
    public code: string,
    public requestId?: string,
  ) {
    super(code);
  }
}
export interface Host {
  demo: boolean;
  call<T = unknown>(action: string, input?: Record<string, unknown>): Promise<T>;
  upload(path: string, file: File): Promise<void>;
  download(path: string): Promise<Blob>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}
let client: SupabaseClient | undefined;
export function configured() {
  return Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
}
export function supabase() {
  if (!configured()) throw new ApiError('SERVER_NOT_CONFIGURED');
  return (client ||= createClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        flowType: 'pkce',
        detectSessionInUrl: false,
        persistSession: true,
        autoRefreshToken: true,
        storageKey: authStorageKey(),
      },
      global: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            cache: 'no-store',
            signal: AbortSignal.any([AbortSignal.timeout(25000), ...(init?.signal ? [init.signal] : [])]),
          }),
      },
    },
  ));
}
function authStorageKey() {
  return 'step-auth-' + new URL(import.meta.env.VITE_SUPABASE_URL).hostname;
}
export function webHost(): Host {
  return {
    demo: false,
    async call<T>(action: string, input: Record<string, unknown> = {}): Promise<T> {
      const db = supabase();
      const {
        data: { session },
      } = await db.auth.getSession();
      if (!session) throw new ApiError('UNAUTHENTICATED');
      let response: Response;
      try {
        response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/api`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + session.access_token,
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({ action, input }),
          cache: 'no-store',
          signal: AbortSignal.timeout(25000),
        });
      } catch {
        throw new ApiError('NETWORK_ERROR');
      }
      const result = await response.json().catch(() => ({ code: 'SERVER_ERROR' }));
      if (response.status === 401) {
        await supabase()
          .auth.signOut({ scope: 'local' })
          .catch(() => {});
        throw new ApiError('UNAUTHENTICATED', result.requestId);
      }
      if (!response.ok) throw new ApiError(result.code || 'SERVER_ERROR', result.requestId);
      return result.data as T;
    },
    async upload(path, file) {
      const result = await supabase()
        .storage.from('documents')
        .upload(path, file, { upsert: false, contentType: file.type });
      if (result.error) throw new ApiError('UPLOAD_FAILED');
    },
    async download(path) {
      const result = await supabase().storage.from('documents').download(path);
      if (result.error || !result.data) throw new ApiError('ACCESS_DENIED');
      return result.data;
    },
    async signIn() {
      sessionStorage.setItem(returnPathKey, returnPath(new URLSearchParams(location.search).get('next')));
      supabase().auth.startAutoRefresh();
      const result = await supabase().auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: location.origin + '/auth/callback', scopes: 'openid email profile' },
      });
      if (result.error) throw new ApiError('GOOGLE_LOGIN_FAILED');
    },
    async signOut() {
      const auth = supabase().auth;
      await auth.stopAutoRefresh();
      try {
        await auth.signOut({ scope: 'local' });
      } finally {
        // Offline failures must not leave a reusable local login behind.
        for (const suffix of ['', '-code-verifier', '-user'])
          localStorage.removeItem(authStorageKey() + suffix);
      }
    },
  };
}
export async function loadSnapshot(host: Host) {
  return host.call<Snapshot>('snapshot');
}
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
