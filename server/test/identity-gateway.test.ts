import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createIdentityGateway } from '../src/identity-gateway.ts';
import { IdentityService } from '../src/identity.ts';
import type { RuntimeDriver } from '../src/workspace/contract.ts';

async function fixture(driver?: RuntimeDriver) {
  const dir = await mkdtemp(join(tmpdir(), 'identity-gateway-'));
  const invitations = join(dir, 'invites.json');
  const entries = ['alice', 'bob'].map((name) => ({
    id: `${name}-invitation-123456`,
    email: `${name}@example.org`,
    expiresAt: '2099-01-01T00:00:00.000Z',
    revoked: false,
  }));
  const save = () => writeFile(invitations, JSON.stringify(entries));
  await save();
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const identities = new IdentityService('example.org', invitations, async (token) => {
    if (token === 'bad') throw new Error('bad token');
    return {
      subject: token,
      email: `${token}@example.org`,
      domain: token === 'outsider' ? 'other.org' : 'example.org',
    };
  });
  const gateway = await createIdentityGateway({
    identities,
    dataRoot: dir,
    clientId: 'synthetic',
    origin,
    driver,
  });
  await new Promise<void>((resolve) => gateway.server.listen(port, '127.0.0.1', resolve));
  async function post(path: string, data: object, token?: string) {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(data),
    });
    return { status: response.status, body: (await response.json()) as Record<string, string> };
  }
  return {
    entries,
    save,
    post,
    close: async () => {
      await gateway.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('invited accounts reach separate engine workspaces; outsiders and cross-account sessions are denied', async () => {
  const f = await fixture();
  try {
    for (const credential of ['bad', 'outsider', 'uninvited'])
      assert.equal((await f.post('/api/login', { credential })).status, 401);
    const alice = (await f.post('/api/login', { credential: 'alice' })).body.token;
    const bob = (await f.post('/api/login', { credential: 'bob' })).body.token;
    const a = await f.post('/api/ask', { text: 'ช่วยคิดชื่องานสัมมนาให้หน่อย' }, alice);
    assert.equal(a.status, 200);
    assert.equal(a.body.answer, 'คำตอบจำลองจาก Desktop engine');
    assert.equal((await f.post('/api/ask', { text: 'ต่อ', sessionId: a.body.sessionId }, bob)).status, 503);
    const b = await f.post('/api/ask', { text: 'ช่วยคิดชื่องานสัมมนาให้หน่อย' }, bob);
    assert.equal(b.status, 200);
    assert.notEqual(a.body.sessionId, b.body.sessionId);
    f.entries[0].revoked = true;
    await f.save();
    assert.equal((await f.post('/api/ask', { text: 'ต่อ' }, alice)).status, 401);
    assert.equal((await f.post('/api/ask', { text: 'ต่อ' }, bob)).status, 200);
  } finally {
    await f.close();
  }
});

test('revocation during an engine request withholds its answer', async () => {
  let started!: () => void, release!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const driver: RuntimeDriver = {
    async start(spec) {
      return {
        async health() {
          return { ok: true, workspaceId: spec.workspaceId };
        },
        onExit() {},
        async stop() {},
        async call(method: string) {
          if (method === 'connect') return { ok: true } as never;
          started();
          await held;
          return { status: 'review', answer: 'private', sessionId: 's', sources: [] } as never;
        },
      };
    },
  };
  const f = await fixture(driver);
  try {
    const token = (await f.post('/api/login', { credential: 'alice' })).body.token;
    const request = f.post('/api/ask', { text: 'ข้อความสังเคราะห์' }, token);
    await running;
    f.entries[0].revoked = true;
    await f.save();
    release();
    const result = await request;
    assert.equal(result.status, 401);
    assert.equal(result.body.answer, undefined);
  } finally {
    release();
    await f.close();
  }
});
