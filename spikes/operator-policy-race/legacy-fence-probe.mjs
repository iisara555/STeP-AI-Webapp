import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Select the checkout under test explicitly, or default to this artifact's checkout.
const checkout = resolve(process.env.LEGACY_CHECKOUT ?? fileURLToPath(new URL('../..', import.meta.url)));
const legacy = pathToFileURL(join(checkout, 'server/src/gateway/invitation-store.ts')).href;
const tsx = pathToFileURL(createRequire(join(checkout, 'package.json')).resolve('tsx')).href;
function legacyChild(db, operation) {
  const script = `import { InvitationStore } from ${JSON.stringify(legacy)};
    const store = new InvitationStore(process.argv[1], ['step.example'], new Set(['root@step.example']));
    ${operation}
    store.close();`;
  return spawnSync(process.execPath, ['--import', tsx, '--input-type=module', '-e', script, db], {
    cwd: checkout,
    encoding: 'utf8',
    timeout: 10000,
  });
}

test('legacy writer ignores new schema version and creates its own table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invitation-fence-'));
  try {
    const path = join(dir, 'new.sqlite');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version=99; CREATE TABLE coordinated_ceiling (email TEXT PRIMARY KEY);');
    db.close();
    const child = legacyChild(
      path,
      "store.change('root@step.example', 'alice@step.example', false, new Set(['root@step.example','alice@step.example']));",
    );
    assert.equal(child.status, 0, child.stderr);
    const verify = new DatabaseSync(path);
    assert.equal(verify.prepare('PRAGMA user_version').get().user_version, 99);
    assert.equal(
      verify.prepare('SELECT active FROM invitations WHERE email=?').get('alice@step.example').active,
      0,
    );
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid legacy view blocks legacy mutation and dispatch on the fenced database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invitation-view-fence-'));
  try {
    const path = join(dir, 'fenced.sqlite');
    const db = new DatabaseSync(path);
    db.exec(
      'PRAGMA user_version=99; CREATE VIEW invitations AS SELECT email, active FROM legacy_access_forbidden;',
    );
    db.close();
    for (const op of [
      "store.dispatch('alice@step.example', () => console.log('DISPATCHED'));",
      "store.change('root@step.example', 'alice@step.example', false, new Set(['root@step.example','alice@step.example']));",
    ]) {
      const child = legacyChild(path, op);
      assert.notEqual(child.status, 0, child.stdout);
      assert.match(child.stderr, /legacy_access_forbidden/);
      assert.doesNotMatch(child.stdout, /DISPATCHED/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retired database still allows stale legacy dispatch independently of new policy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invitation-stale-'));
  try {
    const oldPath = join(dir, 'old.sqlite');
    const nextPath = join(dir, 'new.sqlite');
    const db = new DatabaseSync(nextPath);
    db.exec(
      "CREATE TABLE coordinated_ceiling (email TEXT PRIMARY KEY); INSERT INTO coordinated_ceiling VALUES ('root@step.example');",
    );
    db.close();
    const child = legacyChild(
      oldPath,
      "store.dispatch('alice@step.example', () => console.log('DISPATCHED'));",
    );
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /DISPATCHED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
