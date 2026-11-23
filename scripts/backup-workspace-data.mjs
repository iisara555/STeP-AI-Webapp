#!/usr/bin/env node
// Backs up the Cloud Workspace data folder (STEP_DATA_ROOT) and checks that a backup restores.
//
//   node scripts/backup-workspace-data.mjs backup --data ~/step-gateway-data --out ~/step-gateway-backups [--keep 14]
//   node scripts/backup-workspace-data.mjs verify --backup ~/step-gateway-backups/<stamp>
//
// SQLite files are copied with SQLite's online backup, so a running Gateway or runtime is never caught mid-write;
// other files are copied as they are. Symbolic links, sockets and SQLite side files (-wal, -shm, -journal) are
// skipped. Every copy is listed in manifest.json with its size and SHA-256. Output is counts only: no file names,
// no content. Needs Node 22.16 or newer (node:sqlite backup).
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';

const SQLITE = /\.(sqlite|sqlite3|db)$/;
const SIDE_FILE = /\.(sqlite|sqlite3|db)-(wal|shm|journal)$/;
const STAMP = /^\d{8}T\d{6}Z$/;

function fail(message) {
  console.error(`backup-workspace-data: ${message}`);
  process.exit(1);
}

function args(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!key?.startsWith('--') || rest[i + 1] === undefined) fail(`ไม่รู้จักตัวเลือก ${key ?? ''}`);
    options[key.slice(2)] = rest[i + 1];
  }
  return { command, options };
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Every regular file under root, as paths relative to it; links and special files are counted, never followed. */
async function walk(root, dir = root, found = { files: [], skipped: 0 }) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const info = await lstat(path);
    if (info.isDirectory()) await walk(root, path, found);
    else if (info.isFile() && !SIDE_FILE.test(name)) found.files.push(relative(root, path));
    else found.skipped++;
  }
  return found;
}

function integrity(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    return row && Object.values(row)[0] === 'ok';
  } finally {
    db.close();
  }
}

async function backup({ data, out, keep = '14' }) {
  if (!data || !out) fail('ต้องระบุ --data และ --out');
  const keepCount = Number(keep);
  if (!Number.isSafeInteger(keepCount) || keepCount < 1) fail('--keep ต้องเป็นจำนวนเต็มบวก');
  const source = resolve(data);
  const target = resolve(out);
  if (target === source || target.startsWith(source + sep)) fail('--out ต้องอยู่นอก --data');
  await mkdir(target, { recursive: true, mode: 0o700 });

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const partial = join(target, `.${stamp}.${randomUUID()}.partial`);
  const files = [];
  try {
    const { files: names, skipped } = await walk(source);
    for (const name of names) {
      const from = join(source, name);
      const to = join(partial, 'data', name);
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      const sqlite = SQLITE.test(name);
      if (sqlite) {
        const db = new DatabaseSync(from, { readOnly: true });
        try {
          await sqliteBackup(db, to);
        } finally {
          db.close();
        }
        if (!integrity(to)) throw new Error('SQLITE_INTEGRITY');
      } else {
        await copyFile(from, to);
      }
      await chmod(to, 0o600);
      files.push({
        path: name.split(sep).join('/'),
        sqlite,
        bytes: (await lstat(to)).size,
        sha256: await sha256(to),
      });
    }
    const manifest = { version: 1, createdAt: new Date().toISOString(), skipped, files };
    await writeFile(join(partial, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await rename(partial, join(target, stamp));
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    fail(`สำรองไม่สำเร็จ (${error?.code ?? error?.message ?? 'unknown'})`);
  }

  // Keep the newest `keep` backups; never touch anything that is not a finished backup folder.
  const finished = (await readdir(target)).filter((name) => STAMP.test(name)).sort();
  for (const old of finished.slice(0, Math.max(0, finished.length - keepCount)))
    await rm(join(target, old), { recursive: true, force: true });

  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  console.log(
    JSON.stringify({
      ok: true,
      backup: stamp,
      files: files.length,
      sqlite: files.filter((f) => f.sqlite).length,
      bytes,
      kept: Math.min(finished.length, keepCount),
    }),
  );
}

/** Restores the backup into a fresh temporary folder and checks every file against the manifest. */
async function verify({ backup: folder }) {
  if (!folder) fail('ต้องระบุ --backup');
  const root = resolve(folder);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  } catch {
    fail('ไม่พบ manifest.json หรืออ่านไม่ได้');
  }
  const restore = await mkdtemp(join(tmpdir(), 'step-restore-'));
  const problems = { missing: 0, changed: 0, sqliteBroken: 0, extra: 0 };
  try {
    for (const file of manifest.files) {
      const from = join(root, 'data', ...file.path.split('/'));
      const to = join(restore, ...file.path.split('/'));
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      try {
        await copyFile(from, to);
      } catch {
        problems.missing++;
        continue;
      }
      if ((await sha256(to)) !== file.sha256) problems.changed++;
      else if (file.sqlite && !integrity(to)) problems.sqliteBroken++;
    }
    const listed = new Set(manifest.files.map((file) => file.path));
    problems.extra = (await walk(join(root, 'data'))).files.filter(
      (p) => !listed.has(p.split(sep).join('/')),
    ).length;
  } finally {
    await rm(restore, { recursive: true, force: true });
  }
  const ok = Object.values(problems).every((count) => count === 0);
  console.log(JSON.stringify({ ok, files: manifest.files.length, ...problems }));
  if (!ok) process.exit(1);
}

const { command, options } = args(process.argv.slice(2));
if (command === 'backup') await backup(options);
else if (command === 'verify') await verify(options);
else fail('ใช้ backup หรือ verify');
