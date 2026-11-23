// Runs per user per day that survive a Gateway restart (from the Cloud Workspace migration branch, PR #66).
// Stores only the opaque user id, the UTC day and a count; never an email, a prompt or an answer.
import { closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Days of counts kept; older rows are removed when a new day starts. */
const KEEP_DAYS = 35;

export class QuotaStore {
  private readonly db: DatabaseSync;
  private prunedFor = '';

  constructor(path: string) {
    // Create the file private even when the service runs with a permissive umask.
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

  /** Runs counted for this user on this UTC day (`YYYY-MM-DD`). */
  used(userId: string, day: string): number {
    const row = this.db
      .prepare('SELECT runs FROM daily_usage WHERE user_id = ? AND day = ?')
      .get(userId, day);
    return row ? Number(row.runs) : 0;
  }

  /** Counts one run if the user is still under `limit` today, in one statement; false when the limit is reached. */
  reserve(userId: string, day: string, limit: number): boolean {
    if (!Number.isSafeInteger(limit) || limit < 1) return false;
    this.prune(day);
    const result = this.db
      .prepare(
        `INSERT INTO daily_usage (user_id, day, runs) VALUES (?, ?, 1)
        ON CONFLICT (user_id, day) DO UPDATE SET runs = runs + 1 WHERE runs < ?`,
      )
      .run(userId, day, limit);
    return Number(result.changes) === 1;
  }

  close(): void {
    this.db.close();
  }

  private prune(day: string) {
    if (this.prunedFor === day) return;
    const oldest = new Date(Date.parse(`${day}T00:00:00Z`) - KEEP_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    this.db.prepare('DELETE FROM daily_usage WHERE day < ?').run(oldest);
    this.prunedFor = day;
  }
}
