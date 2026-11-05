import { provisionTestQuota } from './support/quota.ts';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { googleIdTokenAuth } from '../src/gateway/auth.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/gateway/http.ts';
import { InvitationStore } from '../src/gateway/invitation-store.ts';
import { RunService } from '../src/gateway/runs.ts';
import { RuntimeManager } from '../src/workspace/manager.ts';

test('revocation while workspace creation is pending prevents publication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-create-revoke-'));
  const base = new Set(['root@step.example', 'alice@step.example']);
  const first = new InvitationStore(
    join(dir, 'invitations.sqlite'),
    ['step.example'],
    new Set(['root@step.example']),
  );
  const second = new InvitationStore(
    join(dir, 'invitations.sqlite'),
    ['step.example'],
    new Set(['root@step.example']),
  );
  const manager = new RuntimeManager({
    workspacesPerUser: 10,
    dataRoot: provisionTestQuota(dir, 10),
    driver: {
      start: async () => {
        throw new Error('unused');
      },
    },
  });
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const create = manager.create.bind(manager);
  manager.create = async (...args) => {
    entered();
    await gate;
    return create(...args);
  };
  const audit = () => {};
  const server = createGateway({
    manager,
    runs: new RunService(manager, audit),
    audit,
    invitations: first,
    authenticate: async () => ({ userId: 'alice', email: 'alice@step.example', admin: false }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const request = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces`, {
      method: 'POST',
      headers: { authorization: 'Bearer alice', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'synthetic' }),
    });
    await ready;
    second.change('root@step.example', 'alice@step.example', false, base);
    release();
    const response = await request;
    assert.equal(response.status, 401);
    assert.deepEqual(await manager.list('alice'), [], 'revoked request published a workspace');
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('token expiring after authentication but before publication leaves no workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-create-expiry-'));
  const store = new InvitationStore(join(dir, 'invitations.sqlite'), ['step.example'], new Set());
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = b64({ alg: 'RS256', kid: 'test' });
  const claims = b64({
    iss: 'accounts.google.com',
    aud: 'client',
    sub: '123',
    email: 'alice@step.example',
    email_verified: true,
    hd: 'step.example',
    exp: 1000,
  });
  const input = `${header}.${claims}`;
  const bearer = `Bearer ${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
  let now = 1_060_000; // exp + 60 seconds remains valid under the existing verifier's skew.
  const authenticate = googleIdTokenAuth({
    clientId: 'client',
    domains: ['step.example'],
    invited: () => store.invited(new Set(['alice@step.example'])),
    keys: async () => [{ ...publicKey.export({ format: 'jwk' }), kid: 'test' }],
    now: () => now,
  });
  const manager = new RuntimeManager({
    workspacesPerUser: 10,
    dataRoot: provisionTestQuota(dir, 10),
    driver: {
      start: async () => {
        throw new Error('unused');
      },
    },
  });
  const create = manager.create.bind(manager);
  manager.create = (actor, input, admit) =>
    create(actor, input, (publish) => {
      now = 1_061_000; // token becomes invalid exactly at the publication boundary
      admit!(publish);
    });
  const audit = () => {};
  const server = createGateway({
    manager,
    runs: new RunService(manager, audit),
    audit,
    invitations: store,
    authenticate,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces`,
      {
        method: 'POST',
        headers: { authorization: bearer, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'synthetic' }),
      },
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await manager.list('g123'), [], 'expired request published a workspace');
    assert.deepEqual(await readdir(join(dir, 'users', 'g123', 'workspaces')), []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('publication is fenced after preparation and denied staging is removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-create-admit-'));
  const base = new Set(['root@step.example', 'alice@step.example']);
  const first = new InvitationStore(
    join(dir, 'invitations.sqlite'),
    ['step.example'],
    new Set(['root@step.example']),
  );
  const second = new InvitationStore(
    join(dir, 'invitations.sqlite'),
    ['step.example'],
    new Set(['root@step.example']),
  );
  const manager = new RuntimeManager({
    workspacesPerUser: 10,
    dataRoot: provisionTestQuota(dir, 10),
    driver: {
      start: async () => {
        throw new Error('unused');
      },
    },
  });
  try {
    await assert.rejects(
      manager.create('alice', { name: 'synthetic' }, (publish) => {
        second.change('root@step.example', 'alice@step.example', false, base);
        first.dispatch('alice@step.example', publish);
      }),
      /UNAUTHENTICATED/,
    );
    assert.deepEqual(await manager.list('alice'), []);
    assert.deepEqual(await readdir(join(dir, 'users', 'alice', 'workspaces')), []);
  } finally {
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent creates remain independent and errors after publication do not undo a workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-create-concurrent-'));
  const manager = new RuntimeManager({
    workspacesPerUser: 10,
    dataRoot: provisionTestQuota(dir, 10),
    driver: {
      start: async () => {
        throw new Error('unused');
      },
    },
  });
  try {
    const results = await Promise.allSettled([
      manager.create('alice', { name: 'one' }),
      manager.create('alice', { name: 'two' }, (publish) => {
        publish();
        throw new Error('commit uncertain');
      }),
      manager.create('alice', { name: 'three' }, () => {
        throw new Error('denied');
      }),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ['fulfilled', 'rejected', 'rejected'],
    );
    assert.deepEqual((await manager.list('alice')).map((workspace) => workspace.name).sort(), ['one', 'two']);
    assert.equal((await readdir(join(dir, 'users', 'alice', 'workspaces'))).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
