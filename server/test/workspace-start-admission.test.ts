import { provisionTestQuota } from './support/quota.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ChildProcess } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { workspacePaths } from '../src/workspace/storage.ts';
import { processDriver } from '../src/workspace/process-driver.ts';
import { InvitationStore } from '../src/gateway/invitation-store.ts';
import { createGateway } from '../src/gateway/http.ts';
import { RunService } from '../src/gateway/runs.ts';
import { heldDriver } from './support/held-driver.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

// Exercise the real HTTP handler without opening a socket (restricted runners cannot listen).
function request(server: ReturnType<typeof createGateway>, method: string, url: string, body?: object) {
  const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
    method,
    url,
    headers: { authorization: 'synthetic', 'content-type': 'application/json' },
  });
  return new Promise<{ status: number; body: string }>((resolve) => {
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader() {},
      writeHead(status: number) {
        this.statusCode = status;
        this.headersSent = true;
        return this;
      },
      end(body = '') {
        resolve({ status: this.statusCode, body });
      },
    };
    server.emit('request', req as unknown as IncomingMessage, res as unknown as ServerResponse);
  });
}

for (const [method, suffix, body] of [
  ['POST', '/start', undefined],
  ['POST', '/conversations', undefined],
  ['GET', '/conversations/c1/messages', undefined],
  ['POST', '/runs', { text: 'synthetic' }],
  ['POST', '/runs', { text: 'synthetic', sessionId: 'c1' }],
] as const) {
  test(`revocation fences indirect HTTP start: ${method} ${suffix} ${JSON.stringify(body)}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'step-start-route-'));
    const store = new InvitationStore(
      join(dir, 'invites.sqlite'),
      ['step.example'],
      new Set(['root@step.example']),
    );
    const runtime = heldDriver();
    let spawns = 0;
    const boundary = deferred();
    runtime.driver.startWithAdmission = async (spec, admit) => {
      // Revoke after the route/manager's earlier authorization checks, immediately before spawn.
      store.change(
        'root@step.example',
        'alice@step.example',
        false,
        new Set(['root@step.example', 'alice@step.example']),
      );
      boundary.resolve();
      let result: ReturnType<typeof runtime.driver.start> | undefined;
      admit(() => {
        spawns++;
        result = runtime.driver.start(spec);
      });
      return result!;
    };
    const manager = new RuntimeManager({
      dataRoot: provisionTestQuota(dir, 10),
      workspacesPerUser: 10,
      driver: runtime.driver,
    });
    const workspace = await manager.create('alice', { name: 'synthetic' });
    const metadata = join(workspacePaths(dir, 'alice', workspace.id).dir, 'workspace.json');
    const before = await readFile(metadata, 'utf8');
    const runs = new RunService(manager, () => {});
    const server = createGateway({
      manager,
      runs,
      audit: () => {},
      invitations: store,
      authenticate: async () => ({ userId: 'alice', email: 'alice@step.example', admin: false }),
    });
    try {
      const response = await request(server, method, `/api/workspaces/${workspace.id}${suffix}`, body);
      if (suffix === '/runs' && body && 'sessionId' in body) {
        // Existing-session runs are accepted asynchronously; their startup still must fail closed.
        assert.ok([202, 401].includes(response.status));
      } else assert.equal(response.status, 401);
      await boundary.promise;
      if (response.status === 202) {
        const accepted = JSON.parse(response.body);
        const deadline = Date.now() + 1000;
        while (runs.get('alice', workspace.id, accepted.id).status === 'running' && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 1));
        assert.equal(runs.get('alice', workspace.id, accepted.id).code, 'UNAUTHENTICATED');
      }
      assert.equal(spawns, 0);
      assert.equal(await readFile(metadata, 'utf8'), before);
    } finally {
      await manager.shutdown();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('shared start checks each caller and permits an authorized waiter after leader denial', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-shared-start-'));
  const runtime = heldDriver();
  const entered = deferred();
  const release = deferred();
  let attempts = 0;
  let spawns = 0;
  let leaderAllowed = true;
  runtime.driver.startWithAdmission = async (spec, admit) => {
    if (++attempts === 1) {
      entered.resolve();
      await release.promise;
    }
    let result: ReturnType<typeof runtime.driver.start> | undefined;
    admit(() => {
      spawns++;
      result = runtime.driver.start(spec);
    });
    return result!;
  };
  const manager = new RuntimeManager({
    dataRoot: provisionTestQuota(dir, 10),
    workspacesPerUser: 10,
    driver: runtime.driver,
  });
  try {
    const workspace = await manager.create('alice', { name: 'synthetic' });
    const leader = assert.rejects(
      manager.start('alice', workspace.id, (spawn) => {
        if (!leaderAllowed) throw new Error('UNAUTHENTICATED');
        spawn();
      }),
      /UNAUTHENTICATED/,
    );
    await entered.promise;
    const waiterChecked = deferred();
    const waiter = manager.start('alice', workspace.id, (spawn) => {
      waiterChecked.resolve();
      spawn();
    });
    await waiterChecked.promise;
    leaderAllowed = false;
    release.resolve();
    await leader;
    assert.equal((await waiter).state, 'running');
    assert.equal(spawns, 1);
    assert.equal(attempts, 2);
  } finally {
    release.resolve();
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('shared waiter revoked during startup fails independently without stopping admitted runtime', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-shared-revoke-'));
  const runtime = heldDriver();
  const entered = deferred();
  const release = deferred();
  let allowed = true;
  let spawns = 0;
  runtime.driver.startWithAdmission = async (spec, admit) => {
    let result: ReturnType<typeof runtime.driver.start> | undefined;
    admit(() => {
      spawns++;
      result = runtime.driver.start(spec);
    });
    entered.resolve();
    await release.promise;
    return result!;
  };
  const manager = new RuntimeManager({
    dataRoot: provisionTestQuota(dir, 10),
    workspacesPerUser: 10,
    driver: runtime.driver,
  });
  try {
    const workspace = await manager.create('alice', { name: 'synthetic' });
    const leader = manager.start('alice', workspace.id, (spawn) => spawn());
    await entered.promise;
    const checked = deferred();
    const waiter = assert.rejects(
      manager.start('alice', workspace.id, (spawn) => {
        if (!allowed) throw new Error('UNAUTHENTICATED');
        checked.resolve();
        spawn();
      }),
      /UNAUTHENTICATED/,
    );
    await checked.promise;
    allowed = false;
    release.resolve();
    await Promise.all([leader, waiter]);
    assert.equal(spawns, 1);
    assert.equal((await manager.get('alice', workspace.id)).state, 'running');
  } finally {
    release.resolve();
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('SQLite admission ends before asynchronous driver preparation and readiness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-start-lock-'));
  const db = join(dir, 'invites.sqlite');
  const admins = new Set(['root@step.example']);
  const first = new InvitationStore(db, ['step.example'], admins);
  const second = new InvitationStore(db, ['step.example'], admins);
  const base = new Set(['root@step.example', 'alice@step.example']);
  const runtime = heldDriver();
  runtime.driver.startWithAdmission = async (spec, admit) => {
    await Promise.resolve();
    // Another connection can acquire the write lock during preparation.
    second.change('root@step.example', 'alice@step.example', true, base);
    let result: ReturnType<typeof runtime.driver.start> | undefined;
    admit(() => {
      result = runtime.driver.start(spec);
    });
    await Promise.resolve();
    second.change('root@step.example', 'alice@step.example', true, base);
    return result!;
  };
  const manager = new RuntimeManager({
    dataRoot: provisionTestQuota(dir, 10),
    workspacesPerUser: 10,
    driver: runtime.driver,
  });
  try {
    const workspace = await manager.create('alice', { name: 'synthetic' });
    assert.equal(
      (await manager.start('alice', workspace.id, (spawn) => first.dispatch('alice@step.example', spawn)))
        .state,
      'running',
    );
  } finally {
    await manager.shutdown();
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('process driver rejects missing or deferred spawn admission without launching a child', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-process-admission-'));
  try {
    const spec = workspacePaths(dir, 'alice', `ws_${'a'.repeat(32)}`);
    const driver = processDriver();
    let late!: () => void;
    await assert.rejects(
      driver.startWithAdmission!(spec, (spawn) => {
        late = spawn;
      }),
      /ADMISSION_SKIPPED/,
    );
    assert.throws(late, /ADMISSION_REPEATED/);
    await assert.rejects(
      driver.startWithAdmission!(spec, () => {
        throw new Error('UNAUTHENTICATED');
      }),
      /UNAUTHENTICATED/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP revoke before manager entry prevents unfenced spawn and metadata writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-start-entry-'));
  const base = new Set(['root@step.example', 'alice@step.example']);
  const store = new InvitationStore(
    join(dir, 'invites.sqlite'),
    ['step.example'],
    new Set(['root@step.example']),
  );
  const runtime = heldDriver();
  const originalDriverStart = runtime.driver.start;
  let spawns = 0;
  runtime.driver.start = (spec) => {
    spawns++;
    return originalDriverStart(spec);
  };
  const manager = new RuntimeManager({
    dataRoot: provisionTestQuota(dir, 10),
    workspacesPerUser: 10,
    driver: runtime.driver,
  });
  const workspace = await manager.create('alice', { name: 'synthetic' });
  const metadata = join(workspacePaths(dir, 'alice', workspace.id).dir, 'workspace.json');
  const before = await readFile(metadata, 'utf8');
  const originalStart = manager.start.bind(manager);
  manager.start = async (...args) => {
    store.change('root@step.example', 'alice@step.example', false, base);
    return originalStart(...args);
  };
  const server = createGateway({
    manager,
    runs: new RunService(manager, () => {}),
    audit: () => {},
    invitations: store,
    authenticate: async () =>
      store.invited(base).has('alice@step.example')
        ? { userId: 'alice', email: 'alice@step.example', admin: false }
        : null,
  });
  try {
    const response = await request(server, 'POST', `/api/workspaces/${workspace.id}/start`);
    assert.equal(response.status, 401);
    assert.equal(spawns, 0, 'revoked request spawned despite final HTTP denial');
    assert.equal(await readFile(metadata, 'utf8'), before);
  } finally {
    await manager.shutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('process driver spawns inside admission and confirms cleanup after a post-spawn error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-process-commit-'));
  const prototype = ChildProcess.prototype as ChildProcess & { spawn: (this: ChildProcess) => void };
  const originalSpawn = prototype.spawn;
  const originalKill = ChildProcess.prototype.kill;
  let inside = false;
  let spawns = 0;
  let exits = 0;
  prototype.spawn = function () {
    assert.equal(inside, true, 'fork escaped the synchronous admission callback');
    spawns++;
    Object.defineProperty(this, 'pid', { value: 12345 });
    setImmediate(() => this.emit('message', { type: 'ready' }));
  };
  ChildProcess.prototype.kill = function () {
    const child = this;
    setImmediate(() => {
      exits++;
      Object.defineProperty(child, 'signalCode', { value: 'SIGKILL' });
      child.emit('exit', null, 'SIGKILL');
    });
    return true;
  };
  try {
    const store = new InvitationStore(':memory:', ['step.example'], new Set());
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);`);
    let commitFailure: unknown;
    const driver = processDriver({ stopTimeoutMs: 20 });
    const spec = workspacePaths(dir, 'alice', `ws_${'a'.repeat(32)}`);
    await assert.rejects(
      driver.startWithAdmission!(spec, (spawn) => {
        inside = true;
        try {
          spawn();
        } finally {
          inside = false;
        }
        try {
          store.dispatch('alice@step.example', () => db.exec('INSERT INTO child VALUES (999)'));
        } catch (error) {
          commitFailure = error;
          throw error;
        }
      }),
      (error) => error === commitFailure,
    );
    assert.match(String(commitFailure), /FOREIGN KEY constraint failed/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM child').get()?.n, 0);
    assert.equal(spawns, 1);
    assert.equal(exits, 1, 'startup rejected before confirming child exit');
    const manager = new RuntimeManager({
      dataRoot: provisionTestQuota(dir, 10),
      workspacesPerUser: 10,
      driver,
    });
    try {
      const workspace = await manager.create('alice', { name: 'spawn COMMIT' });
      await assert.rejects(
        manager.start('alice', workspace.id, (send) => {
          try {
            store.dispatch('alice@step.example', () => {
              const before = spawns;
              inside = true;
              try {
                send();
              } finally {
                inside = false;
              }
              if (spawns > before) db.exec('INSERT INTO child VALUES (999)');
            });
          } catch (error) {
            commitFailure = error;
            throw error;
          }
        }),
        (error) => error === commitFailure,
      );
      assert.match(String(commitFailure), /FOREIGN KEY constraint failed/);
      assert.equal(spawns, 2);
      assert.equal(exits, 2, 'manager rejected before confirming child exit');
      assert.equal(db.prepare('SELECT count(*) AS n FROM child').get()?.n, 0);
      assert.equal((await manager.get('alice', workspace.id)).error, 'RUNTIME_START_FAILED');
    } finally {
      await manager.shutdown();
      store.close();
    }
    await assert.rejects(
      driver.startWithAdmission!(spec, (spawn) => {
        inside = true;
        try {
          spawn();
          spawn();
        } finally {
          inside = false;
        }
      }),
      /RUNTIME_START_ADMISSION_REPEATED/,
    );
    assert.equal(spawns, 3);
    assert.equal(exits, 3, 'repeated admission leaked its first child');
  } finally {
    prototype.spawn = originalSpawn;
    ChildProcess.prototype.kill = originalKill;
    await rm(dir, { recursive: true, force: true });
  }
});
