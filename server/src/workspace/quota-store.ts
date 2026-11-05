// One policy and one SQLite write lock per data root. All creators must cooperate.
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceId } from './contract.ts';

export class WorkspaceQuotaStore {
  private readonly path: string;
  constructor(
    private readonly dataRoot: string,
    readonly workspacesPerUser: number,
  ) {
    if (workspacesPerUser === undefined) throw new Error('QUOTA_POLICY_REQUIRED');
    if (!Number.isSafeInteger(workspacesPerUser) || workspacesPerUser < 1)
      throw new Error('INVALID_QUOTA_POLICY');
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    this.path = join(resolve(dataRoot), 'workspace-quota.sqlite');
    if (!existsSync(this.path)) this.initialize();
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
  private initialize(): void {
    const dir = mkdtempSync(join(resolve(this.dataRoot), '.quota-init-'));
    const candidate = join(dir, 'policy.sqlite');
    try {
      closeSync(openSync(candidate, 'wx', 0o600));
      const db = new DatabaseSync(candidate);
      try {
        db.exec('BEGIN IMMEDIATE');
        db.exec(
          'CREATE TABLE policy (id INTEGER PRIMARY KEY CHECK (id = 1), workspace_limit INTEGER NOT NULL)',
        );
        db.prepare('INSERT INTO policy (id, workspace_limit) VALUES (1, ?)').run(this.workspacesPerUser);
        db.exec('COMMIT');
      } finally {
        db.close();
      }
      try {
        linkSync(candidate, this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  private open(): DatabaseSync {
    const db = new DatabaseSync(this.path);
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  }
  publish(ownerId: string, publish: () => void): void {
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
