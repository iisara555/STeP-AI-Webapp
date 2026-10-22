import { checked, requireEnv, type Actor, type Environment } from './runtime.ts';
import { decrypt, digest, encrypt, pkce, randomToken } from './crypto.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

const GOOGLE_SCOPES = {
  'calendar-read': 'https://www.googleapis.com/auth/calendar.readonly',
  'drive-selected': 'https://www.googleapis.com/auth/drive.file',
} as const;
type Service = keyof typeof GOOGLE_SCOPES;
type Grant = { access_token: string; refresh_token: string; expires_at: number };
type GrantRow = { ciphertext: string; scopes: string[]; google_subject: string; status: string };
async function googleJson(response: Response) {
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'GOOGLE_REAUTH_REQUIRED'
        : response.status === 403
          ? 'GOOGLE_POLICY_BLOCKED'
          : 'GOOGLE_SERVICE_ERROR',
    );
  const text = await response.text();
  if (text.length > 2000000) throw new Error('GOOGLE_RESULT_TOO_LARGE');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('GOOGLE_RESULT_INVALID');
  }
}
export async function beginGoogle(actor: Actor, t: string, services: Service[], env: Environment) {
  const selected = [...new Set(services)].filter((s) => s in GOOGLE_SCOPES);
  if (!selected.length) throw new Error('INVALID_REQUEST');
  const state = randomToken(),
    verifier = randomToken();
  const subject = actor.user.identities?.find((i) => i.provider === 'google')?.identity_data?.sub;
  if (!subject) throw new Error('GOOGLE_IDENTITY_REQUIRED');
  const encrypted = await encrypt(
    { verifier, subject },
    requireEnv(env, 'CREDENTIAL_ENCRYPTION_KEY'),
    `${t}/${actor.user.id}/oauth`,
  );
  await checked(
    actor.service.rpc('put_oauth_state', {
      state_digest: await digest(state),
      t,
      u: actor.user.id,
      encrypted,
      services: selected,
    }),
  );
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: requireEnv(env, 'GOOGLE_WORKSPACE_CLIENT_ID'),
    redirect_uri: requireEnv(env, 'SUPABASE_URL') + '/functions/v1/google-callback',
    response_type: 'code',
    scope: ['openid', 'email', ...selected.map((s) => GOOGLE_SCOPES[s])].join(' '),
    state,
    code_challenge: await pkce(verifier),
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    login_hint: actor.user.email || '',
  }).toString();
  return { url: url.href };
}
export async function finishGoogle(
  request: Request,
  service: SupabaseClient,
  env: Environment,
  fetcher: typeof fetch = fetch,
) {
  const url = new URL(request.url),
    state = url.searchParams.get('state');
  if (!state || state.length > 100) throw new Error('OAUTH_STATE_INVALID');
  const row = await checked(service.rpc('consume_oauth_state', { state_digest: await digest(state) }));
  if (!row) throw new Error('OAUTH_STATE_INVALID');
  if (url.searchParams.has('error')) throw new Error('GOOGLE_CONSENT_DENIED');
  const code = url.searchParams.get('code');
  if (!code || code.length > 4096) throw new Error('OAUTH_CODE_INVALID');
  await checked(service.rpc('worker_user_context', { t: row.tenant_id, u: row.user_id }));
  const binding = `${row.tenant_id}/${row.user_id}`;
  const proof = await decrypt<{ verifier: string; subject: string }>(
    row.verifier_ciphertext,
    requireEnv(env, 'CREDENTIAL_ENCRYPTION_KEY'),
    binding + '/oauth',
  );
  const token = await googleJson(
    await fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: proof.verifier,
        client_id: requireEnv(env, 'GOOGLE_WORKSPACE_CLIENT_ID'),
        client_secret: requireEnv(env, 'GOOGLE_WORKSPACE_CLIENT_SECRET'),
        redirect_uri: requireEnv(env, 'SUPABASE_URL') + '/functions/v1/google-callback',
      }),
    }),
  );
  if (!token.refresh_token || !token.access_token) throw new Error('GOOGLE_REAUTH_REQUIRED');
  const identity = await googleJson(
    await fetcher('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + token.access_token },
      signal: AbortSignal.timeout(15000),
    }),
  );
  if (identity.sub !== proof.subject || !identity.email_verified) throw new Error('GOOGLE_ACCOUNT_MISMATCH');
  const scopes = String(token.scope || '').split(' ');
  if (!(row.services as Service[]).every((s) => scopes.includes(GOOGLE_SCOPES[s])))
    throw new Error('GOOGLE_SCOPE_MISSING');
  const ciphertext = await encrypt(
    {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + Math.min(token.expires_in || 3600, 3600) * 1000,
    },
    requireEnv(env, 'CREDENTIAL_ENCRYPTION_KEY'),
    binding,
  );
  await checked(
    service.rpc('write_google_grant', {
      t: row.tenant_id,
      u: row.user_id,
      encrypted: ciphertext,
      granted_scopes: scopes,
      subject: identity.sub,
      grant_status: 'ready',
    }),
  );
}
export async function googleState(service: SupabaseClient, t: string, u: string) {
  const row = (await checked(service.rpc('read_google_grant', { t, u }))) as GrantRow | null;
  return row
    ? {
        status: row.status,
        services: Object.entries(GOOGLE_SCOPES)
          .filter(([, s]) => row.scopes.includes(s))
          .map(([s]) => s),
      }
    : { status: 'not_connected', services: [] };
}
export async function googleAccess(
  service: SupabaseClient,
  t: string,
  u: string,
  required: Service,
  env: Environment,
  fetcher: typeof fetch = fetch,
) {
  await checked(service.rpc('worker_user_context', { t, u }));
  const row = (await checked(service.rpc('read_google_grant', { t, u }))) as GrantRow | null;
  if (!row) throw new Error('GOOGLE_NOT_CONNECTED');
  if (row.status !== 'ready')
    throw new Error(row.status === 'paused' ? 'GOOGLE_PAUSED' : 'GOOGLE_REAUTH_REQUIRED');
  if (!row.scopes.includes(GOOGLE_SCOPES[required])) throw new Error('GOOGLE_SCOPE_MISSING');
  const binding = `${t}/${u}`,
    secret = requireEnv(env, 'CREDENTIAL_ENCRYPTION_KEY');
  let grant = await decrypt<Grant>(row.ciphertext, secret, binding);
  if (grant.expires_at < Date.now() + 60000) {
    const response = await fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: grant.refresh_token,
        client_id: requireEnv(env, 'GOOGLE_WORKSPACE_CLIENT_ID'),
        client_secret: requireEnv(env, 'GOOGLE_WORKSPACE_CLIENT_SECRET'),
      }),
    });
    if (!response.ok) {
      await checked(
        service.rpc('write_google_grant', {
          t,
          u,
          encrypted: row.ciphertext,
          granted_scopes: row.scopes,
          subject: row.google_subject,
          grant_status: 'reauth_required',
        }),
      );
      throw new Error('GOOGLE_REAUTH_REQUIRED');
    }
    const updated = await googleJson(response);
    if (!updated.access_token) throw new Error('GOOGLE_REAUTH_REQUIRED');
    grant = {
      access_token: updated.access_token,
      refresh_token: updated.refresh_token || grant.refresh_token,
      expires_at: Date.now() + Math.min(updated.expires_in || 3600, 3600) * 1000,
    };
    await checked(
      service.rpc('write_google_grant', {
        t,
        u,
        encrypted: await encrypt(grant, secret, binding),
        granted_scopes: row.scopes,
        subject: row.google_subject,
        grant_status: 'ready',
      }),
    );
  }
  return grant.access_token;
}
export async function setGoogleState(
  service: SupabaseClient,
  t: string,
  u: string,
  status: 'paused' | 'ready' | 'disconnect',
) {
  if (status === 'disconnect') {
    await checked(service.rpc('delete_google_grant', { t, u }));
    return;
  }
  const row = (await checked(service.rpc('read_google_grant', { t, u }))) as GrantRow | null;
  if (!row) throw new Error('GOOGLE_NOT_CONNECTED');
  if (status === 'ready' && row.status === 'reauth_required') throw new Error('GOOGLE_REAUTH_REQUIRED');
  await checked(
    service.rpc('write_google_grant', {
      t,
      u,
      encrypted: row.ciphertext,
      granted_scopes: row.scopes,
      subject: row.google_subject,
      grant_status: status,
    }),
  );
}
export function wantsCalendar(text: string) {
  const explicitRead = /(?:ดู|ตรวจ|เช็ก|เช็ค|เปิด|อ่าน|show|check|read)[\s\S]{0,30}(?:ปฏิทิน|calendar)/i.test(
    text,
  );
  if (
    !explicitRead &&
    /(?:ช่วย(?:เขียน|ร่าง)|ร่าง(?:หนังสือ|จดหมาย|คำเชิญ)|วาระการประชุม|บันทึกการประชุม|meeting\s+(?:minutes|summary|agenda)|draft)/i.test(
      text,
    )
  )
    return false;
  return (
    explicitRead ||
    /(?:ปฏิทิน|google\s*calendar)/i.test(text) ||
    /(?:มี(?:นัด|ประชุม)|(?:นัดหมาย|ประชุม)[\s\S]{0,30}(?:อะไรบ้าง|ไหม|กี่โมง|วันไหน|เมื่อไร)|(?:what|which|when)[\s\S]{0,45}(?:meetings?|appointments?))/i.test(
      text,
    )
  );
}
export function calendarWindow(text: string, now = new Date()) {
  const bangkok = new Date(now.getTime() + 7 * 3600000);
  const start = new Date(Date.UTC(bangkok.getUTCFullYear(), bangkok.getUTCMonth(), bangkok.getUTCDate()));
  let days = 1;
  if (/(?:พรุ่งนี้|tomorrow)/i.test(text)) start.setUTCDate(start.getUTCDate() + 1);
  else if (/(?:อาทิตย์หน้า|สัปดาห์หน้า|next week)/i.test(text)) {
    const dow = start.getUTCDay() || 7;
    start.setUTCDate(start.getUTCDate() + 8 - dow);
    days = 7;
  } else if (/(?:อาทิตย์นี้|สัปดาห์นี้|this week)/i.test(text)) {
    start.setUTCDate(start.getUTCDate() + 1 - (start.getUTCDay() || 7));
    days = 7;
  }
  const min = new Date(start.getTime() - 7 * 3600000),
    max = new Date(min.getTime() + days * 86400000);
  return { timeMin: min.toISOString(), timeMax: max.toISOString(), timeZone: 'Asia/Bangkok' };
}
export async function calendarEvents(
  service: SupabaseClient,
  t: string,
  u: string,
  text: string,
  env: Environment,
  fetcher: typeof fetch = fetch,
) {
  const access = await googleAccess(service, t, u, 'calendar-read', env, fetcher);
  const range = calendarWindow(text);
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  url.search = new URLSearchParams({
    ...range,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '100',
  }).toString();
  const data = await googleJson(
    await fetcher(url, {
      headers: { Authorization: 'Bearer ' + access },
      signal: AbortSignal.timeout(20000),
    }),
  );
  return {
    range,
    events: (data.items || [])
      .filter(
        (e: { eventType?: string; status?: string }) =>
          e.status !== 'cancelled' && e.eventType !== 'workingLocation',
      )
      .map((e: Record<string, unknown>) => ({
        id: e.id,
        summary: e.summary || '(ไม่ระบุชื่อ)',
        start: e.start,
        end: e.end,
        location: e.location || null,
        htmlLink: e.htmlLink,
      })),
    hasMore: Boolean(data.nextPageToken),
  };
}
export async function driveMetadata(
  service: SupabaseClient,
  t: string,
  u: string,
  id: string,
  env: Environment,
  fetcher: typeof fetch = fetch,
) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error('INVALID_REQUEST');
  const access = await googleAccess(service, t, u, 'drive-selected', env, fetcher);
  const metadata = await googleJson(
    await fetcher(
      `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,size,modifiedTime,version,trashed`,
      {
        headers: { Authorization: 'Bearer ' + access },
        signal: AbortSignal.timeout(15000),
      },
    ),
  );
  if (metadata.trashed) throw new Error('GOOGLE_FILE_REMOVED');
  return { metadata, access };
}
export async function driveText(
  service: SupabaseClient,
  t: string,
  u: string,
  id: string,
  env: Environment,
  fetcher: typeof fetch = fetch,
) {
  const { metadata, access } = await driveMetadata(service, t, u, id, env, fetcher);
  const mime = metadata.mimeType;
  const exportMime = mime === 'application/vnd.google-apps.spreadsheet' ? 'text/csv' : 'text/plain';
  const url = mime.startsWith('application/vnd.google-apps.')
    ? `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportMime)}`
    : `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
  if (
    !mime.startsWith('application/vnd.google-apps.') &&
    !['text/plain', 'text/markdown', 'text/csv'].includes(mime)
  )
    throw new Error('GOOGLE_FILE_EXPORT_REQUIRED');
  const response = await fetcher(url, {
    headers: { Authorization: 'Bearer ' + access },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new Error(response.status === 403 ? 'GOOGLE_POLICY_BLOCKED' : 'GOOGLE_FILE_REMOVED');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('GOOGLE_RESULT_INVALID');
  let text = '',
    bytes = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 600000) throw new Error('DOCUMENT_TOO_LARGE');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { text, metadata };
}
