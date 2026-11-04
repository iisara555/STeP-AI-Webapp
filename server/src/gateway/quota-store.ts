// Durable, atomic run admission. Store only an opaque user id, UTC day and count.
import { DatabaseSync } from 'node:sqlite';
import { closeSync, openSync } from 'node:fs';

export class QuotaStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    // Create new databases private even when the service has a permissive umask.
    if (path !== ':memory:') closeSync(openSync(path, 'a', 0o600));
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS daily_usage (
        user_id TEXT NOT NULL,
        day TEXT NOT NULL,
        runs INTEGER NOT NULL,
        PRIMARY KEY (user_id, day)
      )`);
  }

  reserve(userId: string, day: string, limit: number): boolean {
    if (!Number.isSafeInteger(limit) || limit < 1) return false;
    const result = this.db
      .prepare(
        `
      INSERT INTO daily_usage (user_id, day, runs) VALUES (?, ?, 1)
      ON CONFLICT (user_id, day) DO UPDATE SET runs = runs + 1
      WHERE runs < ?
    `,
      )
      .run(userId, day, limit);
    return Number(result.changes) === 1;
  }

  close(): void {
    this.db.close();
  }
}
