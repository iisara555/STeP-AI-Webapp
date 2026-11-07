// Durable launch journal (#62 residual). The writer fence passes a data root to a successor as soon as its holder
// dies, but runtimes launched by that holder can outlive it. Every launch is recorded here, fsynced, before it is
// admitted and spawned; the record is removed only once its processes are proven gone (or were never spawned). A
// successor reaps every entry left open before it admits any start (RuntimeManager).
//
// One file per launch: `<kind>~<unit>` in <dataRoot>/runtime-launches (0700, ours). The NAME is the identity, so an
// entry whose contents a crash truncated still names the unit to reap; the JSON body is informational only. Anything
// in the directory the journal did not write fails closed: an entry that cannot be read can never be skipped.
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { RuntimeLaunchJournal, RuntimeLaunchRecord } from './contract.ts';

export const LAUNCH_JOURNAL_DIR = 'runtime-launches';
const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const UNIT = /^[A-Za-z0-9][A-Za-z0-9@._-]{0,199}$/;
const SEPARATOR = '~';

const unsafe = (cause?: unknown) => new Error('LAUNCH_JOURNAL_UNSAFE', { cause });

export class LaunchJournal implements RuntimeLaunchJournal {
  private constructor(
    private readonly root: string,
    private readonly dir: string,
  ) {}

  /** Opens the journal of a data root; its directory is created by the first record. Call only inside the fence. */
  static open(dataRoot: string): LaunchJournal {
    const root = resolve(dataRoot);
    const journal = new LaunchJournal(root, join(root, LAUNCH_JOURNAL_DIR));
    journal.exists();
    return journal;
  }

  /** Whether the directory exists; throws LAUNCH_JOURNAL_UNSAFE unless it is a private directory of this user. */
  private exists(): boolean {
    let stats;
    try {
      stats = lstatSync(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw unsafe(error);
    }
    const uid = process.getuid?.();
    if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid) || stats.mode & 0o077)
      throw unsafe();
    return true;
  }

  record({
    kind,
    unit,
    workspaceId,
    nonceHash,
  }: RuntimeLaunchRecord & { workspaceId: string; nonceHash?: string }): { resolve(): void } {
    const name = entryName({ kind, unit });
    if (!this.exists()) {
      try {
        mkdirSync(this.dir, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unsafe(error);
      }
      if (!this.exists()) throw unsafe();
      syncDir(this.root);
    }
    const path = join(this.dir, name);
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const body = JSON.stringify({
        kind,
        unit,
        workspaceId,
        ...(nonceHash ? { nonceHash } : {}),
        pid: process.pid,
        recordedAt: new Date().toISOString(),
      });
      writeSync(fd, body + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // The entry must survive a crash as soon as the spawn may happen: the directory entry too.
    syncDir(this.dir);
    let resolved = false;
    return {
      resolve: () => {
        if (resolved) return;
        this.resolve({ kind, unit });
        resolved = true;
      },
    };
  }

  /** Every open entry, oldest name order. Throws LAUNCH_JOURNAL_UNSAFE on anything it cannot account for. */
  pending(): RuntimeLaunchRecord[] {
    if (!this.exists()) return [];
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (error) {
      throw unsafe(error);
    }
    return names.sort().map((name) => {
      const at = name.indexOf(SEPARATOR);
      const record = { kind: name.slice(0, at), unit: name.slice(at + 1) };
      if (at < 0 || !KIND.test(record.kind) || !UNIT.test(record.unit)) throw unsafe(name);
      let stats;
      try {
        stats = lstatSync(join(this.dir, name));
      } catch (error) {
        throw unsafe(error);
      }
      if (!stats.isFile()) throw unsafe(name);
      return record;
    });
  }

  /** Removes an entry once its launch is proven gone; idempotent. */
  resolve(record: RuntimeLaunchRecord): void {
    if (!this.exists()) return;
    try {
      unlinkSync(join(this.dir, entryName(record)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    syncDir(this.dir);
  }
}

function entryName({ kind, unit }: RuntimeLaunchRecord): string {
  if (typeof kind !== 'string' || typeof unit !== 'string' || !KIND.test(kind) || !UNIT.test(unit))
    throw new Error('LAUNCH_JOURNAL_INVALID_RECORD');
  return `${kind}${SEPARATOR}${unit}`;
}

function syncDir(dir: string) {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
