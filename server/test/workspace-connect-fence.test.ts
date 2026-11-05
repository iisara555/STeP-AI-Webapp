import { provisionTestQuota } from './support/quota.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { InvitationStore } from '../src/gateway/invitation-store.ts';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createGateway } from '../src/gateway/http.ts';
import { RunService } from '../src/gateway/runs.ts';
import { heldDriver } from './support/held-driver.ts';

for (const cleanupFails of [false, true]) {
  test(`revocation during grant wait blocks credential enqueue (cleanup fails: ${cleanupFails})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'step-connect-fence-'));
    const store = new InvitationStore(
      join(dir, 'invites.sqlite'),
      ['step.example'],
      new Set(['root@step.example']),
    );
    const other = new InvitationStore(
      join(dir, 'invites.sqlite'),
      ['step.example'],
      new Set(['root@step.example']),
    );
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ready = new Promise<void>((resolve) => (entered = resolve));
    const runtime = heldDriver();
    const start = runtime.driver.start;
    let connects = 0;
    let stops = 0;
    let failStop = cleanupFails;
    runtime.driver.start = async (spec) => {
      const handle = await start(spec);
      const call = handle.call;
      handle.call = ((method: any, params: any) => {
        if (method === 'connect') connects++;
        return call(method, params);
      }) as typeof call;
      const stop = handle.stop;
      handle.stop = async () => {
        stops++;
        if (failStop) throw new Error('synthetic cleanup failure');
        await stop();
      };
      return handle;
    };
    const manager = new RuntimeManager({
      dataRoot: provisionTestQuota(dir, 10),
      workspacesPerUser: 10,
      driver: runtime.driver,
      grant: async () => {
        entered();
        await gate;
        return { baseUrl: 'https://example.com', token: 'synthetic', model: 'synthetic' };
      },
    });
    try {
      const workspace = await manager.create('alice', { name: 'connect fence' });
      const pending = manager.start('alice', workspace.id, (send) =>
        store.dispatch('alice@step.example', send),
      );
      const rejected = assert.rejects(
        pending,
        cleanupFails ? /^WorkspaceError: RUNTIME_START_FAILED$/ : /^GatewayError: UNAUTHENTICATED$/,
      );
      await ready;
      other.change(
        'root@step.example',
        'alice@step.example',
        false,
        new Set(['root@step.example', 'alice@step.example']),
      );
      release();
      await rejected;
      assert.equal(connects, 0, 'credential must never reach revoked runtime');
      assert.equal(stops, 1);
      assert.equal(manager.stats().running, 0);
      if (cleanupFails) {
        assert.equal((await manager.get('alice', workspace.id)).error, 'RUNTIME_START_CLEANUP_FAILED');
        await assert.rejects(manager.start('alice', workspace.id), /RUNTIME_NOT_RUNNING/);
        failStop = false;
        await manager.shutdown();
        assert.equal(stops, 2);
      }
    } finally {
      release();
      await manager.shutdown();
      other.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
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

for (const withStore of [false, true]) {
  test(`expiry during grant wait blocks connect (invitation store: ${withStore})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'step-connect-expiry-'));
    const store = new InvitationStore(':memory:', ['step.example'], new Set());
    const runtime = heldDriver();
    const start = runtime.driver.start;
    let connects = 0;
    let stops = 0;
    let now = 100_000;
    runtime.driver.start = async (spec) => {
      const handle = await start(spec);
      const call = handle.call;
      handle.call = ((method: any, params: any) => {
        if (method === 'connect') connects++;
        return call(method, params);
      }) as typeof call;
      const stop = handle.stop;
      handle.stop = async () => {
        stops++;
        await stop();
      };
      return handle;
    };
    const manager = new RuntimeManager({
      dataRoot: provisionTestQuota(dir, 10),
      workspacesPerUser: 10,
      driver: runtime.driver,
      grant: async () => {
        now = 161_000;
        return { baseUrl: 'https://example.com', token: 'synthetic', model: 'synthetic' };
      },
    });
    const server = createGateway({
      manager,
      runs: new RunService(manager, () => {}),
      audit: () => {},
      now: () => now,
      invitations: withStore ? store : undefined,
      // Deliberately retain the authenticated snapshot: only synchronous admission can reject this.
      authenticate: async () => ({
        userId: 'alice',
        email: 'alice@step.example',
        admin: false,
        tokenExpiresAt: 100,
      }),
    });
    try {
      const workspace = await manager.create('alice', { name: 'expiry' });
      const response = await request(server, 'POST', `/api/workspaces/${workspace.id}/start`);
      assert.equal(response.status, 401);
      assert.equal(JSON.parse(response.body).code, 'UNAUTHENTICATED');
      assert.equal(connects, 0);
      assert.equal(stops, 1);
    } finally {
      await manager.shutdown();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
