import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { DatabaseSync } from 'node:sqlite';
import { createGateway } from '../src/gateway/http.ts';
import { RunService, DEFAULT_QUOTAS } from '../src/gateway/runs.ts';
import type { AddressInfo } from 'node:net';

const driver = {
  start: async () => {
    throw new Error('unused');
  },
};

test('crash during first policy transaction leaves the canonical store recoverable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-init-crash-'));
  try {
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      import { RuntimeManager } from './server/src/workspace/manager.ts';
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) { if (sql.startsWith('CREATE TABLE policy')) process.exit(17); return exec.call(this, sql); };
      new RuntimeManager({dataRoot: process.argv[1], workspacesPerUser: 1, driver: {}});
    `;
    await assert.rejects(
      promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir], {
        cwd: process.cwd(),
      }),
      (e: any) => e.code === 17,
    );
    await assert.rejects(stat(join(dir, 'workspace-quota.sqlite')), { code: 'ENOENT' });
    const manager = new RuntimeManager({ dataRoot: dir, workspacesPerUser: 1, driver });
    await manager.create('alice', { name: 'one' });
    await assert.rejects(manager.create('alice', { name: 'two' }), /QUOTA_WORKSPACES/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('simultaneous first starts atomically agree on one policy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-init-race-'));
  try {
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      import { existsSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { RuntimeManager } from './server/src/workspace/manager.ts';
      const [dir, mine, other, limit] = process.argv.slice(1);
      const exec = DatabaseSync.prototype.exec;
      let waited = false;
      DatabaseSync.prototype.exec = function(sql) {
        if (!waited && sql === 'BEGIN IMMEDIATE') {
          waited = true; writeFileSync(join(dir, mine), 'ready');
          const end = Date.now() + 10000;
          while (!existsSync(join(dir, other))) {
            if (Date.now() > end) throw Error('barrier timeout');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        return exec.call(this, sql);
      };
      try { new RuntimeManager({dataRoot: dir, workspacesPerUser: Number(limit), driver: {}}); console.log('OK'); }
      catch (e) { console.log(e.message); }
    `;
    const execute = (root: string, mine: string, other: string, limit: number) =>
      promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script, root, mine, other, String(limit)],
        { cwd: process.cwd() },
      );
    const results = await Promise.all([execute(dir, 'one', 'two', 1), execute(dir, 'two', 'one', 2)]);
    assert.deepEqual(results.map((result) => result.stdout.trim()).sort(), ['OK', 'QUOTA_POLICY_MISMATCH']);
    const sameDir = await mkdtemp(join(tmpdir(), 'quota-init-same-'));
    try {
      const same = await Promise.all([execute(sameDir, 'one', 'two', 1), execute(sameDir, 'two', 'one', 1)]);
      assert.deepEqual(same.map((result) => result.stdout.trim()).sort(), ['OK', 'OK']);
    } finally {
      await rm(sameDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('asynchronous admission rejection does not crash the process or publish', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-async-'));
  try {
    const script = `
      import { RuntimeManager } from './server/src/workspace/manager.ts';
      const manager = new RuntimeManager({dataRoot: process.argv[1], workspacesPerUser: 1, driver: {start: async () => {throw Error('unused')}}});
      try { await manager.create('alice', {name:'one'}, async publish => { await Promise.resolve(); publish(); }); }
      catch (e) { console.log(e.message); }
      await new Promise(resolve => setTimeout(resolve, 50));
      console.log('COUNT=' + (await manager.list('alice')).length);
    `;
    const result = await promisify(execFile)(
      process.execPath,
      ['--unhandled-rejections=strict', '--import', 'tsx', '--input-type=module', '-e', script, dir],
      { cwd: process.cwd() },
    );
    assert.equal(result.stdout.trim(), 'PUBLICATION_NOT_SYNCHRONOUS\nCOUNT=0');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('swallowed rename failure cannot be mistaken for a successful publication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-rename-'));
  try {
    const script = `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      import {RuntimeManager} from './server/src/workspace/manager.ts';
      const manager = new RuntimeManager({dataRoot: process.argv[1], workspacesPerUser: 1, driver: {}});
      fs.renameSync = () => { throw Error('injected'); }; syncBuiltinESMExports();
      try { await manager.create('alice', {name: 'one'}, publish => { try { publish(); } catch {} }); console.log('CREATED'); }
      catch (e) { console.log(e.message); }
      console.log('COUNT=' + (await manager.list('alice')).length);
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, dir],
      { cwd: process.cwd() },
    );
    assert.equal(stdout.trim(), 'PUBLICATION_NOT_SYNCHRONOUS\nCOUNT=0');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('quota commit failure reports the published workspace for recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-commit-'));
  try {
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      import { RuntimeManager } from './server/src/workspace/manager.ts';
      const manager = new RuntimeManager({dataRoot: process.argv[1], workspacesPerUser: 1, driver: {}});
      const exec = DatabaseSync.prototype.exec;
      let fail = true;
      DatabaseSync.prototype.exec = function(sql) { if (fail && sql === 'COMMIT') { fail = false; throw Error('injected'); } return exec.call(this, sql); };
      try { await manager.create('alice', {name: 'one'}); }
      catch (e) { console.log(e.message + ' ' + e.workspaceId); }
      console.log((await manager.list('alice'))[0].id);
      try { await manager.create('alice', {name: 'two'}); } catch (e) { console.log(e.message); }
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, dir],
      { cwd: process.cwd() },
    );
    const [error, id, quota] = stdout.trim().split('\n');
    assert.equal(error, 'WORKSPACE_PUBLICATION_UNCERTAIN ' + id);
    assert.match(id, /^ws_[a-f0-9]{32}$/);
    assert.equal(quota, 'QUOTA_WORKSPACES');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('post-publication admission failure identifies the recoverable workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-outcome-'));
  try {
    const manager = new RuntimeManager({ dataRoot: dir, workspacesPerUser: 1, driver });
    let error: any;
    try {
      await manager.create('alice', { name: 'one' }, (publish) => {
        publish();
        throw Error('commit failure');
      });
    } catch (e) {
      error = e;
    }
    assert.equal(error?.message, 'WORKSPACE_PUBLICATION_UNCERTAIN');
    const records = await manager.list('alice');
    assert.equal(records.length, 1);
    assert.equal(error.workspaceId, records[0].id);
    await assert.rejects(manager.create('alice', { name: 'two' }), /QUOTA_WORKSPACES/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('gateway reports uncertain publication without leaking the workspace id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-http-'));
  const manager = new RuntimeManager({ dataRoot: dir, workspacesPerUser: 1, driver });
  const audit = () => {};
  const server = createGateway({
    manager,
    audit,
    runs: new RunService(manager, audit),
    quotas: { ...DEFAULT_QUOTAS, workspacesPerUser: 1 },
    authenticate: async () => ({ userId: 'alice', email: 'alice@example.org', admin: false }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const exec = DatabaseSync.prototype.exec;
  let fail = true;
  DatabaseSync.prototype.exec = function (sql: string) {
    if (fail && sql === 'COMMIT') {
      fail = false;
      throw Error('injected');
    }
    return exec.call(this, sql);
  };
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'one' }),
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { code: 'WORKSPACE_PUBLICATION_UNCERTAIN' });
    assert.equal((await manager.list('alice')).length, 1);
  } finally {
    DatabaseSync.prototype.exec = exec;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
