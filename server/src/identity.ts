import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';

const Invitations = z.array(
  z.object({
    id: z.string().min(16).max(128),
    email: z.email().max(254),
    expiresAt: z.iso.datetime(),
    revoked: z.boolean(),
  }),
);
export type VerifiedIdentity = { subject: string; email: string; domain: string };
export type IdentityVerifier = (token: string) => Promise<VerifiedIdentity>;
export type Session = VerifiedIdentity & { userId: string; invitationId: string; expiresAt: number };

/** Google verifies signature, issuer, audience and expiration; hosted-domain and verified email are required too. */
export function googleVerifier(clientId: string): IdentityVerifier {
  const client = new OAuth2Client(clientId);
  return async (token) => {
    const ticket = await client.verifyIdToken({ idToken: token, audience: clientId });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email || p.email_verified !== true || !p.hd) throw new Error('INVALID_IDENTITY');
    return { subject: p.sub, email: p.email.toLowerCase(), domain: p.hd.toLowerCase() };
  };
}

/** Invitations are re-read on each check; replacing/revoking an ID invalidates existing sessions. */
export class IdentityService {
  private sessions = new Map<string, Session>();
  constructor(
    private readonly domain: string,
    private readonly invitationFile: string,
    private readonly verify: IdentityVerifier,
    private readonly now = Date.now,
  ) {}
  private async invitation(email: string, id?: string) {
    const invitations = Invitations.parse(JSON.parse(await readFile(this.invitationFile, 'utf8')));
    return invitations.find(
      (i) =>
        i.email.toLowerCase() === email &&
        (!id || i.id === id) &&
        !i.revoked &&
        Date.parse(i.expiresAt) > this.now(),
    );
  }
  async login(token: string): Promise<string> {
    if (!token || token.length > 16384) throw new Error('DENIED');
    const identity = await this.verify(token);
    const email = identity.email.toLowerCase(),
      domain = this.domain.toLowerCase();
    if (!identity.subject || identity.domain.toLowerCase() !== domain || !email.endsWith('@' + domain))
      throw new Error('DENIED');
    const invitation = await this.invitation(email);
    if (!invitation) throw new Error('DENIED');
    const sessionId = randomBytes(32).toString('hex');
    this.sessions.set(sessionId, {
      ...identity,
      email,
      userId: 'u' + createHash('sha256').update(identity.subject).digest('hex').slice(0, 63),
      invitationId: invitation.id,
      expiresAt: this.now() + 8 * 60 * 60 * 1000,
    });
    return sessionId;
  }
  async authorize(token: string): Promise<Session | undefined> {
    const session = this.sessions.get(token);
    if (!session) return;
    try {
      if (session.expiresAt > this.now() && (await this.invitation(session.email, session.invitationId)))
        return session;
    } catch {
      /* fail closed on missing or invalid invitation store */
    }
    this.sessions.delete(token);
  }
  logout(token: string) {
    this.sessions.delete(token);
  }
}
