// One policy and one SQLite write lock per data root. All creators must cooperate.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { WorkspaceId } from './contract.ts';

export class WorkspaceQuotaStore {
  constructor(
    private readonly dataRoot: string,
    readonly workspacesPerUser: number,
  ) {
    validateLimit(workspacesPerUser);
    const db = this.open();
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const table = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'policy'")
          .get();
        if (!table) throw new Error('QUOTA_POLICY_REQUIRED');
        const row = db.prepare('SELECT workspace_limit FROM policy WHERE id = 1').get();
        if (!row) throw new Error('QUOTA_POLICY_REQUIRED');
        if (row?.workspace_limit !== workspacesPerUser) throw new Error('QUOTA_POLICY_MISMATCH');
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      db.close();
    }
  }
  private open(): DatabaseSync {
    return openPolicy(resolve(this.dataRoot));
  }
  publish(ownerId: string, publish: () => void): void {
    const identity = checkedPolicy(resolve(this.dataRoot));
    const db = this.open();
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT workspace_limit FROM policy WHERE id = 1').get();
        if (row?.workspace_limit !== this.workspacesPerUser) throw new Error('QUOTA_POLICY_MISMATCH');
        const parent = join(resolve(this.dataRoot), 'users', ownerId, 'workspaces');
        const count = readdirSync(parent, { withFileTypes: true }).filter(
          (entry) =>
            (entry.isDirectory() || entry.isSymbolicLink()) && WorkspaceId.safeParse(entry.name).success,
        ).length;
        if (count >= this.workspacesPerUser) throw new Error('QUOTA_WORKSPACES');
        if (!sameFile(identity, checkedPolicy(resolve(this.dataRoot)))) {
          throw new Error('QUOTA_UNSAFE_PATH');
        }
        publish();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      db.close();
    }
  }
}

function openPolicy(root: string, established = true): DatabaseSync {
  const path = join(root, 'workspace-quota.sqlite');
  // Hold a no-follow descriptor and compare inode identities around SQLite open.
  // SQLite still resolves its own pathname; this detects substitution, not a
  // guarantee against a privileged attacker continuously changing the filesystem.
  const identity = checkedPolicy(root, established);
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let db: DatabaseSync | undefined;
  try {
    if (!sameFile(identity, fstatSync(fd))) throw new Error('QUOTA_UNSAFE_PATH');
    db = new DatabaseSync(`${pathToFileURL(path).href}?mode=rw`);
    if (!sameFile(identity, checkedPolicy(root, established))) throw new Error('QUOTA_UNSAFE_PATH');
    db.exec('PRAGMA busy_timeout = 5000');
  } catch (error) {
    db?.close();
    throw error;
  } finally {
    closeSync(fd);
  }
  return db;
}

function validateLimit(limit: number): void {
  if (limit === undefined) throw new Error('QUOTA_POLICY_REQUIRED');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('INVALID_QUOTA_POLICY');
}

// A hard-linked establishment witness is never opened by SQLite. A missing policy
// is an operator recovery incident even while this witness still retains its inode.
const witnessName = '.workspace-quota-established';
function sameFile(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function optionalStat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function checkRoot(root: string): void {
  let part = root;
  while (true) {
    const info = lstatSync(part);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('QUOTA_UNSAFE_PATH');
    const parent = dirname(part);
    if (parent === part) break;
    part = parent;
  }
}
// Inspect every existing ancestor before any write; create missing components
// individually and recheck. This does not fence a hostile concurrent path swap.
function createRoot(root: string): void {
  const missing: string[] = [];
  let current = root;
  while (!optionalStat(current)) {
    missing.push(current);
    current = dirname(current);
  }
  checkRoot(current);
  for (const path of missing.reverse()) {
    checkRoot(dirname(path));
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    checkRoot(path);
  }
}

function checkFiles(root: string): void {
  checkRoot(root);
  for (const name of [
    'workspace-quota.sqlite',
    witnessName,
    'workspace-quota.sqlite-journal',
    'workspace-quota.sqlite-wal',
    'workspace-quota.sqlite-shm',
  ]) {
    const info = optionalStat(join(root, name));
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('QUOTA_UNSAFE_PATH');
  }
}
function checkedPolicy(root: string, established = true) {
  checkFiles(root);
  const policy = optionalStat(join(root, 'workspace-quota.sqlite'));
  const witness = optionalStat(join(root, witnessName));
  if (!policy || (established && !witness)) throw new Error('QUOTA_POLICY_REQUIRED');
  if (witness && !sameFile(policy, witness)) throw new Error('QUOTA_UNSAFE_PATH');
  return policy;
}

// Provisioners may observe the witness between the two publication links. Only
// wait for the winner: never open the witness as SQLite or recreate the policy.
function awaitPublishedPolicy(root: string, limit: number, deadline = performance.now() + 5000): void {
  checkFiles(root);
  const witness = optionalStat(join(root, witnessName));
  if (!witness) throw new Error('QUOTA_POLICY_REQUIRED');
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!optionalStat(join(root, 'workspace-quota.sqlite'))) {
    checkFiles(root);
    const current = optionalStat(join(root, witnessName));
    if (!current || !sameFile(witness, current)) throw new Error('QUOTA_UNSAFE_PATH');
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('QUOTA_POLICY_REQUIRED');
    Atomics.wait(sleeper, 0, 0, Math.min(10, remaining));
  }
  // Publication observed after resuming must still meet the shared deadline.
  if (performance.now() >= deadline) throw new Error('QUOTA_POLICY_REQUIRED');
  const current = checkedPolicy(root);
  if (!sameFile(witness, current)) throw new Error('QUOTA_UNSAFE_PATH');
  new WorkspaceQuotaStore(root, limit);
}

// Explicit intent is bound to the absolute root, never a generic force/reset flag.
export function initializeWorkspaceQuota(
  dataRoot: string,
  workspacesPerUser: number,
  options: { onboardExistingRoot?: string } = {},
): void {
  validateLimit(workspacesPerUser);
  const root = resolve(dataRoot);
  createRoot(root);
  checkFiles(root);
  const path = join(root, 'workspace-quota.sqlite');
  const witness = join(root, witnessName);
  if (optionalStat(witness)) {
    // Never recreate a missing established policy, regardless of onboarding intent.
    awaitPublishedPolicy(root, workspacesPerUser);
    return;
  }
  const explicit = options.onboardExistingRoot === root;
  if (options.onboardExistingRoot !== undefined && !explicit) throw new Error('QUOTA_ONBOARDING_REQUIRED');
  if (readdirSync(root).length && !explicit) {
    // Candidate names are only a reason to observe, never authority to initialize.
    // Even if every candidate disappears, do not reinterpret this root as empty.
    const deadline = performance.now() + 5000;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (true) {
      checkFiles(root);
      if (optionalStat(witness)) {
        awaitPublishedPolicy(root, workspacesPerUser, deadline);
        return;
      }
      const entries = readdirSync(root);
      const candidatesOnly =
        entries.length > 0 &&
        entries.every((name) => {
          if (!name.startsWith('.quota-init-')) return false;
          const info = optionalStat(join(root, name));
          return info?.isDirectory() && !info.isSymbolicLink();
        });
      // Publication can happen during readdir/lstat, including candidate cleanup.
      if (optionalStat(witness)) {
        awaitPublishedPolicy(root, workspacesPerUser, deadline);
        return;
      }
      const remaining = deadline - performance.now();
      if (!candidatesOnly || remaining <= 0) throw new Error('QUOTA_ONBOARDING_REQUIRED');
      Atomics.wait(sleeper, 0, 0, Math.min(10, remaining));
    }
  }
  if (optionalStat(path)) {
    // Authority is published only after validating the existing inode and limit.
    // Keep the SQLite lock through publication; never expose a provisional witness
    // and never remove a witness another initializer may already have observed.
    const identity = checkedPolicy(root, false);
    const db = openPolicy(root, false);
    try {
      db.exec('BEGIN IMMEDIATE');
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'policy'")
        .get();
      if (!table) throw new Error('QUOTA_POLICY_REQUIRED');
      const row = db.prepare('SELECT workspace_limit FROM policy WHERE id = 1').get();
      if (!row) throw new Error('QUOTA_POLICY_REQUIRED');
      if (row.workspace_limit !== workspacesPerUser) throw new Error('QUOTA_POLICY_MISMATCH');
      if (!sameFile(identity, checkedPolicy(root, false))) throw new Error('QUOTA_UNSAFE_PATH');
      try {
        linkSync(path, witness);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      checkedPolicy(root);
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    new WorkspaceQuotaStore(root, workspacesPerUser);
    return;
  }
  const dir = mkdtempSync(join(root, '.quota-init-'));
  const candidate = join(dir, 'policy.sqlite');
  try {
    closeSync(openSync(candidate, 'wx', 0o600));
    const db = new DatabaseSync(candidate);
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec(
        'CREATE TABLE policy (id INTEGER PRIMARY KEY CHECK (id = 1), workspace_limit INTEGER NOT NULL)',
      );
      db.prepare('INSERT INTO policy (id, workspace_limit) VALUES (1, ?)').run(workspacesPerUser);
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    checkFiles(root);
    try {
      // Claim establishment BEFORE exposing the policy. Crash here fails closed;
      // ordinary init must never use the witness to resurrect the policy.
      linkSync(candidate, witness);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      awaitPublishedPolicy(root, workspacesPerUser);
      return;
    }
    checkFiles(root);
    linkSync(candidate, path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  new WorkspaceQuotaStore(root, workspacesPerUser);
}
