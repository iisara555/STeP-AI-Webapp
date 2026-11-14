// Per-user storage pool warnings through the Gateway (docs/migration-decisions.md: warn at 80 % and 95 %).
// The usage source is injected; these tests supply fake pool counts and never touch a real filesystem quota.
import { provisionTestQuota } from './support/quota.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Authenticator, Identity } from '../src/gateway/auth.ts';
import { createGateway } from '../src/gateway/http.ts';
import { RunService } from '../src/gateway/runs.ts';
import type { StorageUsageSource, PoolUsage } from '../src/gateway/storage-usage.ts';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { heldDriver } from './support/held-driver.ts';
import type { brokerQuotaBoundary } from '../src/workspace/native-quota.ts';

const PEOPLE: Record<string, Identity> = {
  alice: { userId: 'alice', email: 'alice@step.example', admin: false },
  bob: { userId: 'bob', email: 'bob@step.example', admin: false },
};
const authenticate: Authenticator = async (header) => PEOPLE[header?.replace(/^Bearer /, '') ?? ''] ?? null;

const GIB = 1024 ** 3;
/** A pool with 1000 units of bytes and inodes, so percentages are exact decimal literals. */
const pool = (bytesUsed: number, inodesUsed = 0): PoolUsage => ({
  bytesUsed,
  bytesHard: 1000,
  inodesUsed,
  inodesHard: 1000,
});

async function withGateway(
  storageUsage: StorageUsageSource | undefined,
  fn: (g: {
    call: (who: string, path: string, init?: RequestInit) => Promise<Response>;
    runtime: ReturnType<typeof heldDriver>;
  }) => Promise<void>,
) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'step-gateway-storage-'));
  provisionTestQuota(dataRoot, 10);
  const runtime = heldDriver();
  const manager = new RuntimeManager({ workspacesPerUser: 10, dataRoot, driver: runtime.driver });
  const audit = () => {};
  const server = createGateway({
    manager,
    runs: new RunService(manager, audit),
    authenticate,
    audit,
    heartbeatMs: 60_000,
    ...(storageUsage ? { storageUsage } : {}),
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (who: string, path: string, init: RequestInit = {}) =>
    fetch(url + path, {
      ...init,
      headers: {
        authorization: `Bearer ${who}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  try {
    await fn({ call, runtime });
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await manager.shutdown();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

test('without a configured usage source the storage endpoint says unavailable, with no numbers', async () => {
  await withGateway(undefined, async ({ call }) => {
    const response = await call('alice', '/api/storage');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { state: 'unavailable' });
  });
});

test('the endpoint answers only for the verified caller, never for an owner named in the request', async () => {
  const asked: string[] = [];
  const pools: Record<string, PoolUsage> = { alice: pool(850), bob: pool(100) };
  const source: StorageUsageSource = {
    async usage(ownerId) {
      asked.push(ownerId);
      return pools[ownerId];
    },
  };
  await withGateway(source, async ({ call }) => {
    assert.equal((await call('mallory', '/api/storage')).status, 401);
    assert.equal((await call('alice', '/api/storage')).status, 200);
    const bob = await (await call('bob', '/api/storage?owner=alice&userId=alice')).json();
    assert.deepEqual(bob, {
      state: 'available',
      level: 'ok',
      bytesPercent: 10,
      inodesPercent: 0,
      worst: 'bytes',
    });
    assert.equal((await call('bob', '/api/storage/alice')).status, 404);
    assert.deepEqual(asked, ['alice', 'bob']);
  });
});

test('each warning boundary of bytes: 79.9 ok, 80 warning, 94.9 warning, 95 critical, 100 full', async () => {
  const cases: [used: number, level: string, percent: number][] = [
    [799, 'ok', 79.9],
    [800, 'warning', 80],
    [949, 'warning', 94.9],
    [950, 'critical', 95],
    [1000, 'full', 100],
  ];
  for (const [used, level, percent] of cases) {
    await withGateway({ usage: async () => pool(used, 10) }, async ({ call }) => {
      assert.deepEqual(await (await call('alice', '/api/storage')).json(), {
        state: 'available',
        level,
        bytesPercent: percent,
        inodesPercent: 1,
        worst: 'bytes',
      });
    });
  }
});

test('the file count (inodes) alone can raise the level, at the same boundaries', async () => {
  const cases: [inodes: number, level: string][] = [
    [799, 'ok'],
    [800, 'warning'],
    [949, 'warning'],
    [950, 'critical'],
    [1000, 'full'],
  ];
  for (const [inodes, level] of cases) {
    await withGateway({ usage: async () => pool(5, inodes) }, async ({ call }) => {
      const status = await (await call('alice', '/api/storage')).json();
      assert.equal(status.level, level, `inodes ${inodes}`);
      assert.equal(status.worst, 'inodes');
      assert.equal(status.bytesPercent, 0.5);
    });
  }
  // Real-sized numbers: 2 GiB of a 10 GiB pool, but 96 % of the file allowance.
  await withGateway(
    {
      usage: async () => ({
        bytesUsed: 2 * GIB,
        bytesHard: 10 * GIB,
        inodesUsed: 96_000,
        inodesHard: 100_000,
      }),
    },
    async ({ call }) => {
      assert.deepEqual(await (await call('alice', '/api/storage')).json(), {
        state: 'available',
        level: 'critical',
        bytesPercent: 20,
        inodesPercent: 96,
        worst: 'inodes',
      });
    },
  );
});

test('a failing or malformed usage source is reported as unavailable, not as numbers', async () => {
  const sources: StorageUsageSource[] = [
    { usage: async () => Promise.reject(new Error('NATIVE_QUOTA_UNVERIFIED')) },
    { usage: async () => ({ bytesUsed: 1, bytesHard: 0, inodesUsed: 0, inodesHard: 10 }) },
    { usage: async () => ({ bytesUsed: -1, bytesHard: 10, inodesUsed: 0, inodesHard: 10 }) },
    { usage: async () => ({ bytesUsed: 1.5, bytesHard: 10, inodesUsed: 0, inodesHard: 10 }) },
    { usage: async () => ({ level: 'ok' }) as unknown as PoolUsage },
  ];
  for (const source of sources)
    await withGateway(source, async ({ call }) => {
      const response = await call('alice', '/api/storage');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { state: 'unavailable' });
    });
});

test('a full pool refuses new saves early with STORAGE_FULL, while reading and stopping keep working', async () => {
  const pools: Record<string, PoolUsage> = { alice: pool(500), bob: pool(500) };
  await withGateway({ usage: async (owner) => pools[owner] }, async ({ call, runtime }) => {
    // Alice saves some work while there is room.
    const ws = await (await call('alice', '/api/workspaces', post({ name: 'งานเดิม' }))).json();
    const run = await call('alice', `/api/workspaces/${ws.id}/runs`, post({ text: 'ข้อความเดิม' }));
    assert.equal(run.status, 202);
    const { id: runId, sessionId } = await run.json();
    runtime.answer(sessionId, 'คำตอบเดิม');
    for (let i = 0; i < 100; i++) {
      const r = await (await call('alice', `/api/workspaces/${ws.id}/runs/${runId}`)).json();
      if (r.status !== 'running') break;
      await new Promise((done) => setTimeout(done, 20));
    }
    const before = await (
      await call('alice', `/api/workspaces/${ws.id}/conversations/${sessionId}/messages`)
    ).json();

    const other = await (
      await call('alice', `/api/workspaces/${ws.id}/conversations`, { method: 'POST' })
    ).json();
    const held = await call(
      'alice',
      `/api/workspaces/${ws.id}/runs`,
      post({ text: 'ยังทำอยู่', sessionId: other.sessionId }),
    );
    assert.equal(held.status, 202);
    const heldRun = (await held.json()).id;

    pools.alice = pool(400, 1000); // full by file count
    const refused = [
      await call('alice', '/api/workspaces', post({ name: 'ใหม่' })),
      await call('alice', `/api/workspaces/${ws.id}/conversations`, { method: 'POST' }),
      await call('alice', `/api/workspaces/${ws.id}/runs`, post({ text: 'ข้อความใหม่', sessionId })),
    ];
    for (const response of refused) {
      assert.equal(response.status, 507);
      assert.deepEqual(await response.json(), { code: 'STORAGE_FULL' });
    }
    // Nothing was created or changed by the refusals.
    assert.equal((await (await call('alice', '/api/workspaces')).json()).length, 1);
    assert.equal((await (await call('alice', `/api/workspaces/${ws.id}/runs`)).json()).length, 2);
    assert.equal((await (await call('alice', `/api/workspaces/${ws.id}/conversations`)).json()).length, 2);
    // Existing data stays readable.
    assert.equal((await call('alice', `/api/workspaces/${ws.id}`)).status, 200);
    assert.equal((await call('alice', `/api/workspaces/${ws.id}/conversations`)).status, 200);
    const after = await call('alice', `/api/workspaces/${ws.id}/conversations/${sessionId}/messages`);
    assert.equal(after.status, 200);
    assert.deepEqual(await after.json(), before);
    assert.ok(before.some((m: { text: string }) => m.text === 'คำตอบเดิม'));
    // A run already accepted before the pool filled can still be cancelled.
    const cancelled = await call('alice', `/api/workspaces/${ws.id}/runs/${heldRun}/cancel`, {
      method: 'POST',
    });
    assert.equal(cancelled.status, 200, await cancelled.clone().text());
    // Bob's pool is his own: he still saves.
    assert.equal((await call('bob', '/api/workspaces', post({ name: 'ของบ็อบ' }))).status, 200);
  });
});

test('critical is a warning only: saves are still accepted below 100 %', async () => {
  await withGateway({ usage: async () => pool(999, 999) }, async ({ call }) => {
    assert.equal((await call('alice', '/api/workspaces', post({ name: 'ยังได้' }))).status, 200);
  });
});

test('an unavailable source does not block saves (the filesystem quota remains the enforcing limit)', async () => {
  await withGateway({ usage: async () => Promise.reject(new Error('down')) }, async ({ call }) => {
    assert.equal((await call('alice', '/api/workspaces', post({ name: 'ทำต่อได้' }))).status, 200);
  });
});

test('the broker boundary’s usage() fits the injectable source without an adapter (type-level)', () => {
  // Compile-time: npm run check fails if the real boundary drifts from what the Gateway accepts.
  type Boundary = ReturnType<typeof brokerQuotaBoundary>;
  const fits: Boundary extends StorageUsageSource ? true : false = true;
  assert.equal(fits, true);
});
