// Tokens the Cloud Workspace Gateway gives each Workspace runtime so the runtime's AI calls go through the AI gateway
// under its owner's name and quota. Signed with a secret shared by the two processes on the same server; a runtime
// keeps its token in memory only (ADR 0001 §3). The AI gateway still checks the invite list on every request, so
// removing someone revokes their runtime's token at once.
import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'stepint';
const MAX_TTL_MS = 7 * 86_400_000;

export type InternalIdentity = { userId: string; email: string };

export function internalTokens(secret: string, now: () => number = Date.now) {
  if (secret.length < 32) throw new Error('STEP_AI_INTERNAL_SECRET must be at least 32 characters');
  const mac = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');
  return {
    sign(who: InternalIdentity, ttlMs = MAX_TTL_MS) {
      const payload = Buffer.from(
        JSON.stringify({ u: who.userId, e: who.email.toLowerCase(), x: now() + Math.min(ttlMs, MAX_TTL_MS) }),
      ).toString('base64url');
      return `${PREFIX}.${payload}.${mac(payload)}`;
    },
    /** The identity inside a valid, unexpired token, or null. */
    verify(token: string): InternalIdentity | null {
      const [prefix, payload, signature, ...rest] = token.split('.');
      if (prefix !== PREFIX || !payload || !signature || rest.length) return null;
      const expected = Buffer.from(mac(payload));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (
          typeof claims.u !== 'string' ||
          !/^g[0-9]{1,40}$/.test(claims.u) ||
          typeof claims.e !== 'string' ||
          typeof claims.x !== 'number' ||
          claims.x < now()
        )
          return null;
        return { userId: claims.u, email: claims.e };
      } catch {
        return null;
      }
    },
  };
}
