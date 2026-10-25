import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { exchangeCodeOnce, verifiedIdentity } from '../web/src/auth.ts';
import { loginPath, pagePaths, returnPath, routePage } from '../web/src/routes.ts';

test('protected page destinations reject external URLs, callbacks and encoded redirect tricks', () => {
  for (const page of Object.keys(pagePaths) as (keyof typeof pagePaths)[]) {
    const path = pagePaths[page];
    assert.equal(routePage(path), page);
    assert.equal(returnPath(path), path);
  }
  for (const next of [
    null,
    'https://attacker.example.test',
    '//attacker.example.test',
    '/\\attacker.example.test',
    '/auth/callback?code=synthetic',
    '/login?next=/settings',
    '/settings?next=https://attacker.example.test',
    '%2F%2Fattacker.example.test',
  ])
    assert.equal(returnPath(next), '/');
  assert.equal(loginPath('/documents'), '/login?next=%2Fdocuments');
});

test('PKCE callback replay shares one exchange, including failed exchanges', async () => {
  for (const error of [null, { message: 'synthetic failure' }]) {
    let calls = 0;
    const db = {
      auth: {
        async exchangeCodeForSession() {
          calls++;
          return { error };
        },
      },
    } as unknown as SupabaseClient;
    const results = await Promise.allSettled([
      exchangeCodeOnce(db, 'synthetic-code'),
      exchangeCodeOnce(db, 'synthetic-code'),
    ]);
    assert.equal(calls, 1);
    assert.ok(results.every((r) => r.status === (error ? 'rejected' : 'fulfilled')));
  }
});

test('cached session identity cannot open a protected page without Auth verification', async () => {
  const db = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'forged-user' } } }, error: null }),
      getUser: async () => ({ data: { user: { id: 'verified-user' } }, error: null }),
    },
  } as unknown as SupabaseClient;
  assert.equal(await verifiedIdentity(db), 'verified-user');
  db.auth.getUser = (async () => ({ data: { user: null }, error: { message: 'invalid token' } })) as any;
  await assert.rejects(verifiedIdentity(db), /UNAUTHENTICATED/);
});
