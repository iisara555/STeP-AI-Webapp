import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { googleIdTokenAuth } from '../src/gateway/auth.ts';
import { InvitationStore } from '../src/gateway/invitation-store.ts';
import { createGateway } from '../src/gateway/http.ts';
import type { RuntimeManager } from '../src/workspace/manager.ts';
import type { RunService } from '../src/gateway/runs.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const exp = 1_800_000_000;
const actor = 'root@step.example';
const target = 'staff@step.example';
const admins = new Set([actor]);
const base = new Set([actor, target]);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const payload = `${encode({ alg: 'RS256', kid: 'test' })}.${encode({
  iss: 'accounts.google.com',
  aud: 'test',
  sub: '123',
  email: actor,
  email_verified: true,
  hd: 'step.example',
  exp,
})}`;
const authorization = `Bearer ${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`;

for (const active of [false, true]) {
  for (const pause of ['body', 'base'] as const) {
    for (const expired of [false, true]) {
      test(`${active ? 'allow' : 'deny'} invitation after ${pause} read: ${expired ? 'expired' : 'inclusive 60s skew'}`, async () => {
        let clock = exp * 1000;
        const store = new InvitationStore(':memory:', ['step.example'], admins);
        if (active) store.change(actor, target, false, base);
        const audits: unknown[] = [];
        const advance = () => {
          clock = (exp + (expired ? 61 : 60)) * 1000 + 999;
        };
        const server = createGateway({
          manager: { workspacesPerUser: 10 } as RuntimeManager,
          runs: {} as RunService,
          audit: (event) => {
            audits.push(event);
          },
          invitations: store,
          now: () => clock,
          authenticate: googleIdTokenAuth({
            clientId: 'test',
            domains: ['step.example'],
            admins,
            invited: () => store.invited(base),
            now: () => clock,
            keys: async () => [{ ...publicKey.export({ format: 'jwk' }), kid: 'test' }],
          }),
          baseInvitations: async () => {
            if (pause === 'base') advance();
            return base;
          },
        });
        const req = Object.assign(
          Readable.from(
            (async function* () {
              if (pause === 'body') advance();
              yield Buffer.from(JSON.stringify({ email: target }));
            })(),
          ),
          {
            method: 'POST',
            url: `/api/admin/invitations${active ? '' : '/revoke'}`,
            headers: { authorization, 'content-type': 'application/json' },
          },
        );
        try {
          const result = await new Promise<{ status: number; body: string }>((resolve) => {
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
          assert.equal(result.status, expired ? 401 : 200);
          if (expired) assert.equal(JSON.parse(result.body).code, 'UNAUTHENTICATED');
          assert.equal(store.invited(base).has(target), expired ? !active : active);
          assert.equal(audits.length, expired ? 0 : 1);
          // A rejected credential must also release the transaction.
          store.change(actor, target, true, base);
        } finally {
          store.close();
          server.close();
        }
      });
    }
  }
}

test('credential validation runs under the writer lock and keeps live actor authorization', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await mkdtemp(join(tmpdir(), 'step-admin-boundary-'));
  const path = join(dir, 'invites.sqlite');
  const store = new InvitationStore(path, ['step.example'], admins);
  const other = new DatabaseSync(path);
  other.exec('PRAGMA busy_timeout = 0');
  try {
    let checked = 0;
    store.change(actor, target, false, base, () => {
      checked++;
      assert.throws(() => other.exec('BEGIN IMMEDIATE'), /locked/);
    });
    assert.equal(checked, 1);
    // A cooperating writer can commit after the mutation releases the lock.
    other.exec('BEGIN IMMEDIATE');
    other.prepare('INSERT INTO invitations VALUES (?, 0)').run(actor);
    other.exec('COMMIT');
    assert.throws(
      () =>
        store.change(actor, target, true, base, () => {
          checked++;
        }),
      /FORBIDDEN/,
    );
    assert.equal(checked, 2);
    assert.equal(store.invited(base).has(target), false);
    other.prepare('DELETE FROM invitations WHERE email = ?').run(actor);
    assert.throws(() => store.change(target, target, true, base), /FORBIDDEN/);
    assert.throws(() => store.change(actor, actor, false, base), /FORBIDDEN/);
    assert.throws(() => store.change(actor, 'outside@step.example', true, base), /FORBIDDEN/);
    store.change(actor, target, true, base);
    assert.equal(store.invited(base).has(target), true);
  } finally {
    other.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
