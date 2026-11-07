// One live writer per storage root, across processes (#62). The fence is an SQLite EXCLUSIVE lock on a dedicated file
// under the data root, held in an open transaction for the writer's lifetime. SQLite's unix VFS implements it with
// POSIX fcntl record locks on a descriptor it opens O_CLOEXEC: the kernel drops the lock when the holder process dies
// (no stale PID file to reclaim), a live holder is never overtaken, and fork/exec'd runtime children neither inherit
// the descriptor nor the lock. Within one process SQLite tracks locks per inode, so a second manager is refused too.
//
// POSIX locks are per process and any close(2) of the same inode by this process drops them, which is why this module
// never opens a raw descriptor on an existing fence file: it inspects with lstat and leaves all I/O to SQLite.
import { closeSync, constants, lstatSync, openSync, type Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export const WRITER_FENCE_FILE = 'workspace-writer.fence';

/** Fences stay reachable until released, so garbage collection can never close a live writer's lock. */
const retained = new Set<WriterFence>();

export class WriterFence {
  private constructor(private db: DatabaseSync | undefined) {
    retained.add(this);
  }

  /** Acquires the fence or throws WORKSPACE_WRITER_FENCE_HELD / WORKSPACE_WRITER_FENCE_UNSAFE. Never waits. */
  static acquire(dataRoot: string): WriterFence {
    const path = join(resolve(dataRoot), WRITER_FENCE_FILE);
    let identity = inspect(path);
    if (!identity) {
      try {
        // A brand-new inode, so closing this descriptor cannot drop anyone's lock.
        closeSync(
          openSync(
            path,
            constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unsafe(error);
      }
      identity = inspect(path);
      if (!identity) throw unsafe();
    }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(`${pathToFileURL(path).href}?mode=rw`);
      db.exec('PRAGMA busy_timeout = 0');
      try {
        // Nothing is ever written, so keep any rollback journal in memory rather than beside the fence.
        db.exec('PRAGMA journal_mode = MEMORY');
        db.exec('BEGIN EXCLUSIVE');
      } catch (error) {
        if (/locked|busy/i.test(String((error as Error).message)))
          throw new Error('WORKSPACE_WRITER_FENCE_HELD');
        throw unsafe(error);
      }
      // The pathname must still name the inode we checked; a swapped file would be a lock nobody else contends.
      const after = inspect(path);
      if (!after || after.dev !== identity.dev || after.ino !== identity.ino) throw unsafe();
    } catch (error) {
      try {
        db?.close();
      } catch {
        // The original failure is the one to report.
      }
      throw error;
    }
    return new WriterFence(db);
  }

  get held(): boolean {
    return this.db !== undefined;
  }

  /** Releases the fence; idempotent. Only call once every write by this holder has finished. */
  release(): void {
    const db = this.db;
    if (!db) return;
    this.db = undefined;
    retained.delete(this);
    try {
      db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  }
}

function unsafe(cause?: unknown): Error {
  return new Error('WORKSPACE_WRITER_FENCE_UNSAFE', { cause });
}

/** A private regular file owned by this user, or undefined when absent. Anything else fails closed. */
function inspect(path: string): Stats | undefined {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw unsafe(error);
  }
  const uid = process.getuid?.();
  if (!stats.isFile() || stats.nlink !== 1 || (uid !== undefined && stats.uid !== uid) || stats.mode & 0o077)
    throw unsafe();
  return stats;
}
