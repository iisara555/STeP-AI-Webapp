// Who is calling the Gateway (ADR 0001 §3): a Google account of the organization's domain that has been invited.
// The bearer is a Google ID token; the Gateway keeps no password and no Google access to the user's data.
import { createPublicKey, verify, type webcrypto } from 'node:crypto';

export type Identity = {
  /** Stable id from Google's `sub`; the folder name under users/ (UserId in workspace/contract.ts). */
  userId: string;
  email: string;
  admin: boolean;
};

/** Returns the caller, or null when the request carries no acceptable credential. */
export type Authenticator = (authorization: string | undefined) => Promise<Identity | null>;

type Jwk = webcrypto.JsonWebKey & { kid?: string };

export type GoogleAuthOptions = {
  /** The OAuth client id the web app signs in with; the token's audience must be exactly this. */
  clientId: string;
  /** Organization domains, checked against the token's `hd` claim and the email's domain. */
  domains: string[];
  /** Invited emails (lowercase), read on every request so a removal takes effect at once. */
  invited: () => Set<string> | Promise<Set<string>>;
  admins?: Set<string>;
  /** Google's signing keys; tests pass their own. */
  keys?: () => Promise<Jwk[]>;
  now?: () => number;
};

const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const SKEW_SECONDS = 60;

export function googleIdTokenAuth(options: GoogleAuthOptions): Authenticator {
  const keys = options.keys ?? googleKeys();
  const now = options.now ?? Date.now;
  const domains = new Set(options.domains.map((d) => d.toLowerCase()));
  const admins = options.admins ?? new Set<string>();
  return async (authorization) => {
    const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? '')?.[1];
    if (!token) return null;
    const [head, body, signature] = token.split('.');
    let header: { alg?: string; kid?: string }, claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (header.alg !== 'RS256' || !header.kid) return null;
    const jwk = (await keys()).find((key) => key.kid === header.kid);
    if (!jwk) return null;
    const valid = verify(
      'RSA-SHA256',
      Buffer.from(`${head}.${body}`),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(signature, 'base64url'),
    );
    if (!valid) return null;
    const seconds = Math.floor(now() / 1000);
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
    if (
      !ISSUERS.has(String(claims.iss)) ||
      claims.aud !== options.clientId ||
      typeof claims.exp !== 'number' ||
      claims.exp + SKEW_SECONDS < seconds ||
      (typeof claims.iat === 'number' && claims.iat - SKEW_SECONDS > seconds) ||
      claims.email_verified !== true ||
      typeof claims.sub !== 'string' ||
      !/^[0-9]{1,40}$/.test(claims.sub) ||
      !domains.has(String(claims.hd ?? '').toLowerCase()) ||
      !domains.has(email.split('@')[1] ?? '')
    )
      return null;
    if (!(await options.invited()).has(email)) return null;
    return { userId: `g${claims.sub}`, email, admin: admins.has(email) };
  };
}

/** Google's published keys, cached for as long as Google's response allows (at most a day). */
function googleKeys(url = 'https://www.googleapis.com/oauth2/v3/certs') {
  let cached: { keys: Jwk[]; until: number } | undefined;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.keys;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('AUTH_KEYS_UNAVAILABLE');
    const { keys } = (await response.json()) as { keys: Jwk[] };
    const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1] ?? 3600);
    cached = { keys, until: Date.now() + Math.min(maxAge, 86_400) * 1000 };
    return keys;
  };
}
