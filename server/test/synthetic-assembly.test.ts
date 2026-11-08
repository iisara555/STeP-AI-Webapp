import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createSyntheticAssembly } from '../src/gateway/synthetic-assembly.ts';
import { provisionTestQuota } from './support/quota.ts';

test(
  'ten authenticated synthetic users run concurrently, deny other owners, and resume persistent history',
  { timeout: 90_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'step-assembly-'));
    const assembly = createSyntheticAssembly({
      purpose: 'synthetic-only',
      dataRoot: provisionTestQuota(join(root, 'data'), 2),
      workspacesPerUser: 2,
      runtime: { kind: 'namespace', socketRoot: root },
      authenticate: async (header) => {
        const match = /^Bearer synthetic-(\d)$/.exec(header ?? '');
        return match
          ? { userId: `synthetic-${match[1]}`, email: `synthetic-${match[1]}@example.invalid`, admin: false }
          : null;
      },
    });
    await new Promise<void>((done) => assembly.server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(assembly.server.address() as AddressInfo).port}`;
    const call = (user: number, path: string, body?: unknown) =>
      fetch(url + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer synthetic-${user}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      assert.equal((await fetch(url + '/api/workspaces')).status, 401);
      const workspaces = await Promise.all(
        Array.from({ length: 10 }, async (_, i) => {
          const response = await call(i, '/api/workspaces', { name: `Synthetic ${i}` });
          assert.equal(response.status, 200);
          return response.json();
        }),
      );
      // Awaiting Promise.all on all starts proves ten live runtimes, not ten serial turns.
      await Promise.all(
        workspaces.map(async (ws, i) => {
          const response = await call(i, `/api/workspaces/${ws.id}/start`, {});
          assert.equal(response.status, 200, await response.text());
        }),
      );
      assert.deepEqual(assembly.manager.stats(), { running: 10, starting: 0, failed: 0, max: 10, busy: 0 });
      const runs = await Promise.all(
        workspaces.map(async (ws, i) => {
          const response = await call(i, `/api/workspaces/${ws.id}/runs`, {
            text: 'ช่วยคิดชื่องานสัมมนาให้หน่อย',
          });
          assert.equal(response.status, 202);
          return response.json();
        }),
      );
      await Promise.all(
        workspaces.map(async (ws, i) => {
          let run;
          const deadline = Date.now() + 30_000;
          do {
            run = await (await call(i, `/api/workspaces/${ws.id}/runs/${runs[i].id}`)).json();
            if (run.status !== 'running') break;
            assert.ok(Date.now() < deadline, 'run completed before deadline');
            await new Promise((done) => setTimeout(done, 50));
          } while (true);
          assert.equal(run.status, 'done', JSON.stringify(run));
          const firstMessages = await (
            await call(i, `/api/workspaces/${ws.id}/conversations/${run.sessionId}/messages`)
          ).json();
          assert.equal(firstMessages.at(-1).text, 'คำตอบจำลองจาก Desktop engine');
          assert.equal((await call((i + 1) % 10, `/api/workspaces/${ws.id}`)).status, 404);
          assert.equal(
            (await call((i + 1) % 10, `/api/workspaces/${ws.id}/conversations/${run.sessionId}/messages`))
              .status,
            404,
          );
          assert.equal((await call(i, `/api/workspaces/${ws.id}/stop`, {})).status, 200);
          const resumed = await assembly.manager.ask(`synthetic-${i}`, ws.id, {
            text: 'ขออีกสามชื่อ',
            sessionId: run.sessionId,
          });
          assert.equal(resumed.sessionId, run.sessionId);
          const messages = await (
            await call(i, `/api/workspaces/${ws.id}/conversations/${run.sessionId}/messages`)
          ).json();
          assert.deepEqual(
            messages.map((message: { role: string }) => message.role),
            ['user', 'assistant', 'user', 'assistant'],
          );
        }),
      );
    } finally {
      await assembly.close();
      assert.deepEqual(
        (await readdir(root)).filter((name) => name.startsWith('ipc-')),
        [],
      );
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('the synthetic assembly reports storage only from an injected usage source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'step-assembly-storage-'));
  const authenticate = async (header?: string) =>
    header === 'Bearer synthetic-a'
      ? { userId: 'synthetic-a', email: 'a@example.invalid', admin: false }
      : null;
  const asked: string[] = [];
  const make = (storageUsage?: { usage(owner: string): Promise<any> }) =>
    createSyntheticAssembly({
      purpose: 'synthetic-only',
      dataRoot: provisionTestQuota(join(root, storageUsage ? 'with' : 'without'), 2),
      workspacesPerUser: 2,
      runtime: { kind: 'namespace', socketRoot: root },
      authenticate,
      ...(storageUsage ? { storageUsage } : {}),
    });
  const assemblies = [
    make(),
    make({
      usage: async (owner) => {
        asked.push(owner);
        return { bytesUsed: 10, bytesHard: 10, inodesUsed: 1, inodesHard: 10 };
      },
    }),
  ];
  try {
    const [without, withUsage] = await Promise.all(
      assemblies.map(async (assembly) => {
        await new Promise<void>((done) => assembly.server.listen(0, '127.0.0.1', done));
        const url = `http://127.0.0.1:${(assembly.server.address() as AddressInfo).port}`;
        return (path: string, body?: unknown) =>
          fetch(url + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { authorization: 'Bearer synthetic-a', 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
      }),
    );
    assert.deepEqual(await (await without('/api/storage')).json(), { state: 'unavailable' });
    assert.equal((await without('/api/workspaces', { name: 'ok' })).status, 200);
    assert.deepEqual(await (await withUsage('/api/storage')).json(), {
      state: 'available',
      level: 'full',
      bytesPercent: 100,
      inodesPercent: 10,
      worst: 'bytes',
    });
    const refused = await withUsage('/api/workspaces', { name: 'full' });
    assert.equal(refused.status, 507);
    assert.deepEqual(await refused.json(), { code: 'STORAGE_FULL' });
    assert.deepEqual(asked, ['synthetic-a', 'synthetic-a']);
  } finally {
    await Promise.all(assemblies.map((assembly) => assembly.close()));
    await rm(root, { recursive: true, force: true });
  }
});
