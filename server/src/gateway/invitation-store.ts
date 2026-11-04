import { closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { GatewayError } from './runs.ts';

/** Durable administrator denials; the operator file is the maximum permitted set. */
export class InvitationStore {
  private readonly db: DatabaseSync;
  private readonly domains: Set<string>;
  constructor(
    path: string,
    domains: string[],
    private readonly admins: Set<string>,
  ) {
    this.domains = new Set(domains.map((domain) => domain.toLowerCase()));
    if (path !== ':memory:') closeSync(openSync(path, 'a', 0o600));
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS invitations (email TEXT PRIMARY KEY, active INTEGER NOT NULL CHECK(active IN (0, 1)))`);
  }
  invited(base: Set<string>): Set<string> {
    const result = new Set(base);
    for (const row of this.db.prepare('SELECT email, active FROM invitations').all()) {
      if (row.active === 0) result.delete(String(row.email));
    }
    return result;
  }
  /** Serialize a synchronous enqueue with administrator invitation changes across SQLite connections.
   * Never wait for IO or backpressure in this callback; the transaction must not span an async operation.
   */
  dispatch<T>(email: string, send: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT active FROM invitations WHERE email = ?').get(email);
      if (row?.active === 0) throw new GatewayError('UNAUTHENTICATED');
      const result = send();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  change(actor: string, email: string, active: boolean, base: Set<string>): void {
    const normalized = email.toLowerCase();
    if (
      !z.email().safeParse(normalized).success ||
      normalized.length > 254 ||
      !this.domains.has(normalized.split('@')[1])
    )
      throw new GatewayError('INVALID_INPUT');
    if (this.admins.has(normalized) || (active && !base.has(normalized))) throw new GatewayError('FORBIDDEN');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.admins.has(actor) || !this.invited(base).has(actor)) throw new GatewayError('FORBIDDEN');
      this.db
        .prepare(
          `INSERT INTO invitations (email, active) VALUES (?, ?)
        ON CONFLICT(email) DO UPDATE SET active = excluded.active`,
        )
        .run(normalized, active ? 1 : 0);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
}
