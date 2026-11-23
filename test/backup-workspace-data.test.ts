import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'backup-workspace-data.mjs');
const node = (...args: string[]) => run(process.execPath, ['--no-warnings', SCRIPT, ...args]);

async function syntheticData(root: string) {
  const workspace = join(root, 'data', 'users', 'gsynthetic', 'workspaces', 'w1');
  await mkdir(join(workspace, 'files'), { recursive: true });
  const db = new DatabaseSync(join(workspace, 'workspace.sqlite'));
  db.exec(
    "PRAGMA journal_mode = WAL; CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('ข้อมูลจำลอง')",
  );
  await writeFile(join(workspace, 'files', 'draft.docx'), 'synthetic');
  await writeFile(join(root, 'data', 'invites.txt'), 'someone@step.example\n');
  await symlink('/etc/hostname', join(root, 'data', 'outside-link'));
  // Left open, so the WAL side files exist while the backup runs, as with a live Gateway.
  return db;
}

test('backs up live SQLite and files, skips links, keeps the newest backups and verifies a restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'step-backup-'));
  const db = await syntheticData(root);
  try {
    const out = join(root, 'backups');
    const first = JSON.parse(
      (await node('backup', '--data', join(root, 'data'), '--out', out, '--keep', '2')).stdout,
    );
    assert.equal(first.ok, true);
    assert.equal(first.files, 3);
    assert.equal(first.sqlite, 1);
    const stdout = JSON.stringify(first);
    assert.ok(!stdout.includes('invites') && !stdout.includes('someone'), 'output names no files or content');

    const folder = join(out, first.backup);
    assert.equal((await stat(folder)).mode & 0o777, 0o700);
    const copy = new DatabaseSync(
      join(folder, 'data', 'users', 'gsynthetic', 'workspaces', 'w1', 'workspace.sqlite'),
    );
    assert.deepEqual(
      copy
        .prepare('SELECT body FROM notes')
        .all()
        .map((row) => row.body),
      ['ข้อมูลจำลอง'],
    );
    copy.close();

    const verified = JSON.parse((await node('verify', '--backup', folder)).stdout);
    assert.deepEqual(verified, { ok: true, files: 3, missing: 0, changed: 0, sqliteBroken: 0, extra: 0 });

    // A changed file is reported and the check fails.
    await appendFile(join(folder, 'data', 'invites.txt'), 'tampered\n');
    await assert.rejects(node('verify', '--backup', folder), (error: { code: number; stdout: string }) => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).changed, 1);
      return true;
    });

    for (let i = 0; i < 2; i++) {
      await new Promise((done) => setTimeout(done, 1100));
      await node('backup', '--data', join(root, 'data'), '--out', out, '--keep', '2');
    }
    assert.equal((await readdir(out)).filter((name) => /^\d{8}T\d{6}Z$/.test(name)).length, 2);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a backup folder inside the data folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'step-backup-'));
  try {
    await mkdir(join(root, 'data'));
    await assert.rejects(node('backup', '--data', join(root, 'data'), '--out', join(root, 'data', 'b')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
