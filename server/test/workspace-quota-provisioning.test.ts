import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { symlinkSync, mkdirSync, closeSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeManager } from '../src/workspace/manager.ts';
import * as quota from '../src/workspace/quota-store.ts';

// Ordinary startup must never create authority, even on an apparently new root.
test('ordinary startup requires operator provisioning and leaves a missing policy absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-unprovisioned-'));
  try {
    assert.throws(() => new quota.WorkspaceQuotaStore(root, 1), /QUOTA_POLICY_REQUIRED/);
    await assert.rejects(stat(join(root, 'workspace-quota.sqlite')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('deleted established policy cannot silently adopt the same or a different limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-deleted-'));
  try {
    quota.initializeWorkspaceQuota(root, 1);
    const store = new quota.WorkspaceQuotaStore(root, 1);
    await rm(join(root, 'workspace-quota.sqlite'));
    for (const limit of [2, 1]) {
      assert.throws(() => new quota.WorkspaceQuotaStore(root, limit), /QUOTA_POLICY_REQUIRED/);
      await assert.rejects(stat(join(root, 'workspace-quota.sqlite')), { code: 'ENOENT' });
    }
    let published = false;
    assert.throws(() =>
      store.publish('alice', () => {
        published = true;
      }),
    );
    assert.equal(published, false);
    await assert.rejects(stat(join(root, 'workspace-quota.sqlite')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit provisioning validates existing policy and never repairs corruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-explicit-'));
  try {
    assert.equal(typeof quota.initializeWorkspaceQuota, 'function');
    quota.initializeWorkspaceQuota(root, 1);
    quota.initializeWorkspaceQuota(root, 1);
    new quota.WorkspaceQuotaStore(root, 1);
    assert.throws(() => quota.initializeWorkspaceQuota(root, 2), /QUOTA_POLICY_MISMATCH/);
    assert.throws(() => new quota.WorkspaceQuotaStore(root, 2), /QUOTA_POLICY_MISMATCH/);
    await writeFile(join(root, 'workspace-quota.sqlite'), 'corrupt synthetic policy');
    assert.throws(() => new quota.WorkspaceQuotaStore(root, 1));
    assert.throws(() => quota.initializeWorkspaceQuota(root, 1));
    assert.equal(await readFile(join(root, 'workspace-quota.sqlite'), 'utf8'), 'corrupt synthetic policy');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const legacy of [false, true]) {
  for (const limits of [
    [1, 1],
    [1, 2],
  ]) {
    test(
      `concurrent explicit provisioning publishes one complete policy (${limits}, legacy=${legacy})`,
      { timeout: 30000 },
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'quota-provision-race-'));
        if (legacy) {
          const db = new DatabaseSync(join(root, 'workspace-quota.sqlite'));
          db.exec('CREATE TABLE policy (id INTEGER PRIMARY KEY, workspace_limit INTEGER NOT NULL)');
          db.exec('INSERT INTO policy VALUES (1, 1)');
          db.close();
        }
        const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { resolve, join } from 'node:path';
      import { initializeWorkspaceQuota } from './server/src/workspace/quota-store.ts';
      const [root, mine, other, limit] = process.argv.slice(1);
      const link = fs.linkSync;
      const open = fs.openSync;
      let first = true;
      fs.${legacy ? 'openSync' : 'linkSync'} = (...args) => {
        if (${legacy} && (!first || String(args[0]) !== join(root, "workspace-quota.sqlite"))) return open(...args);
        first = false;
        // Both candidates have committed and closed before either publishes.
        fs.writeFileSync(join(root, mine + '.ready'), 'ready');
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(join(root, other + '.ready'))) {
          if (Date.now() > deadline) throw Error('barrier timeout');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        return ${legacy ? 'open' : 'link'}(...args);
      };
      syncBuiltinESMExports();
      try { initializeWorkspaceQuota(root, Number(limit), {onboardExistingRoot:root}); console.log('OK'); }
      catch (e) { console.log(e.message); }
    `;
        const execute = async (mine: string, other: string, limit: number) => {
          // Files also work in restricted hosts where child stdio pipes are unavailable.
          const output = join(root, mine + '.output');
          const fd = openSync(output, 'wx', 0o600);
          try {
            const child = spawn(
              process.execPath,
              ['--import', 'tsx', '--input-type=module', '-e', script, root, mine, other, String(limit)],
              { stdio: ['ignore', fd, 'ignore'] },
            );
            await new Promise<void>((resolve, reject) => {
              child.once('error', reject);
              child.once('exit', (code, signal) =>
                code === 0 ? resolve() : reject(new Error(`provisioner exited ${code}/${signal}`)),
              );
            });
            return (await readFile(output, 'utf8')).trim();
          } finally {
            closeSync(fd);
          }
        };
        try {
          const results = await Promise.all([
            execute('one', 'two', limits[0]),
            execute('two', 'one', limits[1]),
          ]);
          assert.deepEqual(
            results.sort(),
            limits[0] === limits[1] ? ['OK', 'OK'] : ['OK', 'QUOTA_POLICY_MISMATCH'],
          );
          const db = new DatabaseSync(join(root, 'workspace-quota.sqlite'), { readOnly: true });
          const winner = db.prepare('SELECT workspace_limit FROM policy WHERE id = 1').get()!
            .workspace_limit as number;
          db.close();
          assert.ok(limits.includes(winner));
          new quota.WorkspaceQuotaStore(root, winner);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  }
}

test('deleting policy after workspace publication denies old and restarted managers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-manager-deleted-'));
  try {
    quota.initializeWorkspaceQuota(root, 1);
    const driver = {
      start: async () => {
        throw Error('unused');
      },
    };
    const manager = new RuntimeManager({ dataRoot: root, workspacesPerUser: 1, driver });
    const first = await manager.create('alice', { name: 'synthetic' });
    await rm(join(root, 'workspace-quota.sqlite'));
    assert.throws(
      () => new RuntimeManager({ dataRoot: root, workspacesPerUser: 2, driver }),
      /QUOTA_POLICY_REQUIRED/,
    );
    await assert.rejects(manager.create('alice', { name: 'denied' }), /QUOTA_POLICY_REQUIRED/);
    assert.deepEqual(
      (await manager.list('alice')).map((workspace) => workspace.id),
      [first.id],
    );
    await assert.rejects(stat(join(root, 'workspace-quota.sqlite')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit provisioning cannot repair a missing row in an established policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-empty-policy-'));
  try {
    quota.initializeWorkspaceQuota(root, 1);
    const db = new DatabaseSync(join(root, 'workspace-quota.sqlite'));
    db.exec('DELETE FROM policy');
    db.close();
    assert.throws(() => quota.initializeWorkspaceQuota(root, 2), /QUOTA_POLICY_REQUIRED/);
    assert.throws(() => new quota.WorkspaceQuotaStore(root, 1), /QUOTA_POLICY_REQUIRED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary provisioning cannot resurrect a deleted established policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-no-reset-'));
  try {
    quota.initializeWorkspaceQuota(root, 1);
    await rm(join(root, 'workspace-quota.sqlite'));
    for (const limit of [9, 1]) {
      assert.throws(() => quota.initializeWorkspaceQuota(root, limit), /QUOTA_POLICY_REQUIRED/);
    }
    await assert.rejects(stat(join(root, 'workspace-quota.sqlite')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('policy symlinks are rejected on startup, publication and provisioning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-links-'));
  const other = await mkdtemp(join(tmpdir(), 'quota-target-'));
  try {
    quota.initializeWorkspaceQuota(root, 1);
    quota.initializeWorkspaceQuota(other, 1);
    const store = new quota.WorkspaceQuotaStore(root, 1);
    await rm(join(root, 'workspace-quota.sqlite'));
    symlinkSync(join(other, 'workspace-quota.sqlite'), join(root, 'workspace-quota.sqlite'));
    assert.throws(() => new quota.WorkspaceQuotaStore(root, 1), /QUOTA_UNSAFE_PATH/);
    assert.throws(() => quota.initializeWorkspaceQuota(root, 1), /QUOTA_UNSAFE_PATH/);
    assert.throws(() => store.publish('alice', () => assert.fail('published')), /QUOTA_UNSAFE_PATH/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test('populated roots require explicit root-bound onboarding intent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-onboard-'));
  try {
    mkdirSync(join(root, 'users'));
    assert.throws(() => quota.initializeWorkspaceQuota(root, 1), /QUOTA_ONBOARDING_REQUIRED/);
    assert.throws(
      () => quota.initializeWorkspaceQuota(root, 1, { onboardExistingRoot: root + '-wrong' }),
      /QUOTA_ONBOARDING_REQUIRED/,
    );
    quota.initializeWorkspaceQuota(root, 1, { onboardExistingRoot: resolve(root) });
    new quota.WorkspaceQuotaStore(root, 1);
    await rm(join(root, 'workspace-quota.sqlite'));
    assert.throws(
      () => quota.initializeWorkspaceQuota(root, 9, { onboardExistingRoot: root }),
      /QUOTA_POLICY_REQUIRED/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const name of [
  'workspace-quota.sqlite',
  '.workspace-quota-established',
  'workspace-quota.sqlite-journal',
  'workspace-quota.sqlite-wal',
  'workspace-quota.sqlite-shm',
]) {
  for (const kind of ['directory', 'dangling-symlink']) {
    test(`reject unsafe ${kind} at ${name} on every boundary`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'quota-unsafe-'));
      try {
        quota.initializeWorkspaceQuota(root, 1);
        const store = new quota.WorkspaceQuotaStore(root, 1);
        await rm(join(root, name), { force: true });
        if (kind === 'directory') mkdirSync(join(root, name));
        else symlinkSync(join(root, 'absent'), join(root, name));
        assert.throws(() => new quota.WorkspaceQuotaStore(root, 1), /QUOTA_UNSAFE_PATH/);
        assert.throws(() => quota.initializeWorkspaceQuota(root, 1), /QUOTA_UNSAFE_PATH/);
        assert.throws(() => store.publish('alice', () => assert.fail('published')), /QUOTA_UNSAFE_PATH/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test('symlink data root is rejected even with explicit onboarding intent', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'quota-root-link-'));
  try {
    const target = join(parent, 'real');
    mkdirSync(target);
    const alias = join(parent, 'alias');
    symlinkSync(target, alias);
    assert.throws(
      () => quota.initializeWorkspaceQuota(alias, 1, { onboardExistingRoot: alias }),
      /QUOTA_UNSAFE_PATH/,
    );
    await assert.rejects(stat(join(target, 'workspace-quota.sqlite')), { code: 'ENOENT' });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('path substitution between no-follow open and SQLite open fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-open-race-'));
  const other = await mkdtemp(join(tmpdir(), 'quota-open-target-'));
  const original = fs.openSync;
  try {
    quota.initializeWorkspaceQuota(root, 1);
    quota.initializeWorkspaceQuota(other, 1);
    const policy = join(root, 'workspace-quota.sqlite');
    const store = new quota.WorkspaceQuotaStore(root, 1);
    let swapped = false;
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      const fd = original(...args);
      if (args[0] === policy && !swapped) {
        swapped = true;
        fs.renameSync(policy, policy + '.saved');
        fs.symlinkSync(join(other, 'workspace-quota.sqlite'), policy);
      }
      return fd;
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    assert.throws(() => store.publish('alice', () => assert.fail('published')), /QUOTA_UNSAFE_PATH/);
    assert.equal(swapped, true);
  } finally {
    fs.openSync = original;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test('interrupted provisioning after establishment never reprovisions on retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-claim-crash-'));
  const original = fs.linkSync;
  try {
    fs.linkSync = ((source: fs.PathLike, target: fs.PathLike) => {
      if (target === join(root, 'workspace-quota.sqlite')) throw Error('simulated crash after witness');
      return original(source, target);
    }) as typeof fs.linkSync;
    syncBuiltinESMExports();
    assert.throws(() => quota.initializeWorkspaceQuota(root, 1), /simulated crash/);
    fs.linkSync = original;
    syncBuiltinESMExports();
    assert.throws(() => new quota.WorkspaceQuotaStore(root, 1), /QUOTA_POLICY_REQUIRED/);
    assert.throws(() => quota.initializeWorkspaceQuota(root, 9), /QUOTA_POLICY_REQUIRED/);
    assert.throws(
      () => quota.initializeWorkspaceQuota(root, 9, { onboardExistingRoot: root }),
      /QUOTA_POLICY_REQUIRED/,
    );
    await assert.rejects(stat(join(root, 'workspace-quota.sqlite')), { code: 'ENOENT' });
  } finally {
    fs.linkSync = original;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy policy onboarding requires root confirmation and preserves its limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-legacy-'));
  try {
    const db = new DatabaseSync(join(root, 'workspace-quota.sqlite'));
    db.exec('CREATE TABLE policy (id INTEGER PRIMARY KEY, workspace_limit INTEGER NOT NULL)');
    db.exec('INSERT INTO policy VALUES (1, 1)');
    db.close();
    assert.throws(() => new quota.WorkspaceQuotaStore(root, 1), /QUOTA_POLICY_REQUIRED/);
    assert.throws(() => quota.initializeWorkspaceQuota(root, 1), /QUOTA_ONBOARDING_REQUIRED/);
    assert.throws(
      () => quota.initializeWorkspaceQuota(root, 9, { onboardExistingRoot: root }),
      /QUOTA_POLICY_MISMATCH/,
    );
    quota.initializeWorkspaceQuota(root, 1, { onboardExistingRoot: root });
    new quota.WorkspaceQuotaStore(root, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Exit at the actual authority publication syscall, bypassing catch/finally cleanup.
test('crash at witness publication cannot authorize a mismatched legacy policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-legacy-crash-'));
  try {
    const db = new DatabaseSync(join(root, 'workspace-quota.sqlite'));
    db.exec('CREATE TABLE policy (id INTEGER PRIMARY KEY, workspace_limit INTEGER NOT NULL)');
    db.exec('INSERT INTO policy VALUES (1, 1)');
    db.close();
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { initializeWorkspaceQuota, WorkspaceQuotaStore } from './server/src/workspace/quota-store.ts';
      const root = process.argv[1];
      const link = fs.linkSync;
      fs.linkSync = (...args) => {
        link(...args);
        if (String(args[1]).endsWith('.workspace-quota-established')) {
          try { new WorkspaceQuotaStore(root, 1); fs.writeFileSync(root + '/early-reader', 'accepted'); } catch {}
          process.exit(73);
        }
      };
      syncBuiltinESMExports();
      try { initializeWorkspaceQuota(root, 9, { onboardExistingRoot: root }); }
      catch (e) { if (e.message === 'QUOTA_POLICY_MISMATCH') process.exit(74); throw e; }
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root], {
      stdio: 'ignore',
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.throws(() => new quota.WorkspaceQuotaStore(root, 1), /QUOTA_POLICY_REQUIRED/);
    assert.equal(fs.existsSync(join(root, 'early-reader')), false);
    assert.equal(code, 74, 'mismatch must be rejected before the crash/publication hook');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reject symlink ancestor before creating any missing descendant', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'quota-mkdir-link-'));
  try {
    mkdirSync(join(parent, 'target'));
    symlinkSync(join(parent, 'target'), join(parent, 'alias'));
    const root = join(parent, 'alias', 'must-not-exist', 'data');
    assert.throws(
      () => quota.initializeWorkspaceQuota(root, 1, { onboardExistingRoot: root }),
      /QUOTA_UNSAFE_PATH/,
    );
    assert.equal(fs.existsSync(join(parent, 'target', 'must-not-exist')), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('validated legacy onboarding has a single authority publication point across crash and readers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-valid-crash-'));
  try {
    const db = new DatabaseSync(join(root, 'workspace-quota.sqlite'));
    db.exec('CREATE TABLE policy (id INTEGER PRIMARY KEY, workspace_limit INTEGER NOT NULL)');
    db.exec('INSERT INTO policy VALUES (1, 1)');
    db.close();
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { initializeWorkspaceQuota, WorkspaceQuotaStore } from './server/src/workspace/quota-store.ts';
      const root = process.argv[1];
      const link = fs.linkSync;
      fs.linkSync = (...args) => {
        if (!String(args[1]).endsWith('.workspace-quota-established')) return link(...args);
        try { new WorkspaceQuotaStore(root, 1); process.exit(75); }
        catch (e) { if (e.message !== 'QUOTA_POLICY_REQUIRED') throw e; }
        link(...args);
        process.exit(73);
      };
      syncBuiltinESMExports();
      initializeWorkspaceQuota(root, 1, { onboardExistingRoot: root });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root], {
      stdio: 'ignore',
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 73);
    new quota.WorkspaceQuotaStore(root, 1);
    quota.initializeWorkspaceQuota(root, 1, { onboardExistingRoot: root });
    assert.throws(
      () => quota.initializeWorkspaceQuota(root, 9, { onboardExistingRoot: root }),
      /QUOTA_POLICY_MISMATCH/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const limit of [1, 2]) {
  test(
    `initializer entering between witness and policy links waits for publication (limit=${limit})`,
    { timeout: 15000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'quota-link-interleave-'));
      const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { initializeWorkspaceQuota } from './server/src/workspace/quota-store.ts';
      const [root, role, limit] = process.argv.slice(1);
      const wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      const link = fs.linkSync;
      const stat = fs.lstatSync;
      if (role === 'winner') fs.linkSync = (...args) => {
        link(...args);
        if (String(args[1]).endsWith('.workspace-quota-established')) {
          fs.writeFileSync(root + '/ready', '');
          const deadline = Date.now() + 10000;
          while (!fs.existsSync(root + '/observed')) {
            if (Date.now() > deadline) throw Error('barrier timeout');
            wait();
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        }
      };
      else fs.lstatSync = (...args) => {
        const result = stat(...args);
        if (String(args[0]).endsWith('.workspace-quota-established')) fs.writeFileSync(root + '/observed', '');
        return result;
      };
      syncBuiltinESMExports();
      console.error('synthetic warning: stdout must remain independently parseable');
      try { initializeWorkspaceQuota(root, Number(limit), { onboardExistingRoot: root }); console.log('OK'); }
      catch (e) { console.log(e.message); }
    `;
      const execute = (role: string, requested: number) => {
        const output = join(root, role + '.stdout');
        const fd = openSync(output, 'wx', 0o600);
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', script, root, role, String(requested)],
          { stdio: ['ignore', fd, 'ignore'] },
        );
        closeSync(fd);
        return new Promise<string>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', async (code) => {
            try {
              assert.equal(code, 0);
              resolve((await readFile(output, 'utf8')).trim());
            } catch (error) {
              reject(error);
            }
          });
        });
      };
      try {
        const winner = execute('winner', 1);
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(join(root, 'ready'))) {
          if (Date.now() > deadline) throw Error('winner barrier timeout');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.throws(() => new quota.WorkspaceQuotaStore(root, 1), /QUOTA_POLICY_REQUIRED/);
        const loser = execute('loser', limit);
        assert.deepEqual(await Promise.all([winner, loser]), [
          'OK',
          limit === 1 ? 'OK' : 'QUOTA_POLICY_MISMATCH',
        ]);
        new quota.WorkspaceQuotaStore(root, 1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

for (const limit of [1, 2]) {
  test(
    `normal initializer entering after candidate mkdir waits for publication (limit=${limit})`,
    { timeout: 15000 },
    async () => {
      const control = await mkdtemp(join(tmpdir(), 'quota-mkdir-interleave-'));
      const root = join(control, 'data');
      mkdirSync(root);
      const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { initializeWorkspaceQuota } from './server/src/workspace/quota-store.ts';
      const [root, control, role, limit] = process.argv.slice(1);
      const wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      const mkdir = fs.mkdtempSync;
      const read = fs.readdirSync;
      if (role === 'winner') fs.mkdtempSync = (...args) => {
        const result = mkdir(...args);
        if (String(args[0]).includes('.quota-init-')) {
          fs.writeFileSync(control + '/ready', '');
          const deadline = Date.now() + 10000;
          while (!fs.existsSync(control + '/observed')) {
            if (Date.now() > deadline) throw Error('barrier timeout');
            wait();
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        }
        return result;
      };
      else fs.readdirSync = (...args) => {
        const result = read(...args);
        if (String(args[0]) === root) fs.writeFileSync(control + '/observed', '');
        return result;
      };
      syncBuiltinESMExports();
      console.error('synthetic warning: stdout must remain independently parseable');
      try { initializeWorkspaceQuota(root, Number(limit)); console.log('OK'); }
      catch (e) { console.log(e.message); }
    `;
      const execute = (role: string, requested: number) => {
        const output = join(control, role + '.stdout');
        const fd = openSync(output, 'wx', 0o600);
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', script, root, control, role, String(requested)],
          { stdio: ['ignore', fd, 'ignore'] },
        );
        closeSync(fd);
        return new Promise<string>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', async (code) => {
            try {
              assert.equal(code, 0);
              resolve((await readFile(output, 'utf8')).trim());
            } catch (error) {
              reject(error);
            }
          });
        });
      };
      try {
        const winner = execute('winner', 1);
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(join(control, 'ready'))) {
          if (Date.now() > deadline) throw Error('winner barrier timeout');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.throws(() => new quota.WorkspaceQuotaStore(root, 1), /QUOTA_POLICY_REQUIRED/);
        const loser = execute('loser', limit);
        assert.deepEqual(await Promise.all([winner, loser]), [
          'OK',
          limit === 1 ? 'OK' : 'QUOTA_POLICY_MISMATCH',
        ]);
        new quota.WorkspaceQuotaStore(root, 1);
      } finally {
        await rm(control, { recursive: true, force: true });
      }
    },
  );
}

test('forged candidate directories never authorize provisioning', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-forged-candidate-'));
  try {
    mkdirSync(join(root, '.quota-init-forged'));
    await writeFile(join(root, '.quota-init-forged', 'policy.sqlite'), 'synthetic forgery');
    assert.throws(() => quota.initializeWorkspaceQuota(root, 1), /QUOTA_ONBOARDING_REQUIRED/);
    assert.equal(fs.existsSync(join(root, 'workspace-quota.sqlite')), false);
    assert.equal(fs.existsSync(join(root, '.workspace-quota-established')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const kind of ['symlink', 'file', 'populated']) {
  test(`candidate-shaped ${kind} does not grant onboarding authority`, async () => {
    const control = await mkdtemp(join(tmpdir(), 'quota-fake-candidate-'));
    const root = join(control, 'data');
    mkdirSync(root);
    try {
      const candidate = join(root, '.quota-init-forged');
      if (kind === 'symlink') symlinkSync(control, candidate);
      else if (kind === 'file') await writeFile(candidate, 'synthetic');
      else {
        mkdirSync(candidate);
        mkdirSync(join(root, 'users'));
      }
      assert.throws(() => quota.initializeWorkspaceQuota(root, 1), /QUOTA_ONBOARDING_REQUIRED/);
      assert.equal(fs.existsSync(join(root, 'workspace-quota.sqlite')), false);
      assert.equal(fs.existsSync(join(root, '.workspace-quota-established')), false);
    } finally {
      await rm(control, { recursive: true, force: true });
    }
  });
}

test('disappearing candidate never changes an observed populated root into authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-candidate-disappears-'));
  const read = fs.readdirSync;
  try {
    const candidate = join(root, '.quota-init-stale');
    mkdirSync(candidate);
    fs.readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => {
      const result = read(...args);
      if (args[0] === root) fs.rmSync(candidate, { recursive: true, force: true });
      return result;
    }) as typeof fs.readdirSync;
    syncBuiltinESMExports();
    assert.throws(() => quota.initializeWorkspaceQuota(root, 1), /QUOTA_ONBOARDING_REQUIRED/);
    assert.equal(fs.existsSync(join(root, 'workspace-quota.sqlite')), false);
    assert.equal(fs.existsSync(join(root, '.workspace-quota-established')), false);
  } finally {
    fs.readdirSync = read;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

for (const phase of ['witness', 'candidate'] as const) {
  test(`policy published after the observation deadline is rejected (${phase})`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'quota-late-policy-'));
    try {
      quota.initializeWorkspaceQuota(root, 1);
      const policy = join(root, 'workspace-quota.sqlite');
      const witness = join(root, '.workspace-quota-established');
      const candidate = join(root, '.quota-init-synthetic');
      mkdirSync(candidate);
      const saved = join(candidate, 'policy');
      fs.linkSync(policy, saved);
      fs.unlinkSync(policy);
      if (phase === 'candidate') fs.unlinkSync(witness);
      let now = 0;
      let waits = 0;
      t.mock.method(performance, 'now', () => now);
      t.mock.method(Atomics, 'wait', () => {
        waits++;
        // Simulate resuming after descheduling, with publication already complete.
        now = 5001;
        if (phase === 'candidate') fs.linkSync(saved, witness);
        fs.linkSync(saved, policy);
        return 'timed-out';
      });
      assert.throws(() => quota.initializeWorkspaceQuota(root, 1), /QUOTA_POLICY_REQUIRED/);
      assert.equal(waits, 1);
      assert.equal(fs.statSync(policy).ino, fs.statSync(saved).ino);
      assert.equal(fs.statSync(witness).ino, fs.statSync(saved).ino);
      // Rejection leaves the published policy intact; a fresh attempt can validate it.
      t.mock.restoreAll();
      quota.initializeWorkspaceQuota(root, 1);
    } finally {
      t.mock.restoreAll();
      await rm(root, { recursive: true, force: true });
    }
  });
}
