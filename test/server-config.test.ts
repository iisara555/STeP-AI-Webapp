import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverEnvironment, configUnavailable } from '../supabase/functions/_shared/server-config.ts';
import { dispatch } from '../supabase/functions/_shared/api.ts';
import type { Actor } from '../supabase/functions/_shared/runtime.ts';

const tenant = '10000000-0000-4000-8000-000000000001';
const base = (name: string) =>
  ({
    SUPABASE_URL: 'https://synthetic.supabase.co',
    SUPABASE_SECRET_KEY: 'synthetic-service-value',
    APP_ORIGIN: 'https://app.example.test',
  })[name];
test('Vault fallback allows only named server configuration and environment values win', async () => {
  const fetched: string[] = [];
  const env = await serverEnvironment(base, (async (url) => {
    fetched.push(String(url));
    return Response.json({
      APP_ORIGIN: 'https://old.example.test',
      OPENROUTER_API_KEY: 'synthetic-vault-value',
      OPENROUTER_TRIAL_TENANT_ID: tenant,
      SUPABASE_SECRET_KEY: 'must-not-override-service',
      UNEXPECTED: 'must-not-load',
      WORKER_SECRET: {},
      GOOGLE_WORKSPACE_CLIENT_SECRET: 'must-not-load',
    });
  }) as typeof fetch);
  assert.deepEqual(fetched, ['https://synthetic.supabase.co/rest/v1/rpc/read_server_runtime_config']);
  assert.equal(env('APP_ORIGIN'), base('APP_ORIGIN'));
  assert.equal(env('SUPABASE_SECRET_KEY'), base('SUPABASE_SECRET_KEY'));
  assert.equal(env('OPENROUTER_API_KEY'), 'synthetic-vault-value');
  assert.equal(env('OPENROUTER_TRIAL_TENANT_ID'), tenant);
  for (const name of ['UNEXPECTED', 'WORKER_SECRET', 'GOOGLE_WORKSPACE_CLIENT_SECRET'])
    assert.equal(env(name), undefined);
});
test('Vault-loaded key and tenant restriction reach the sandbox without exposing credentials', async () => {
  const env = await serverEnvironment(base, (async () =>
    Response.json({
      OPENROUTER_API_KEY: 'synthetic-vault-value',
      OPENROUTER_TRIAL_TENANT_ID: tenant,
    })) as typeof fetch);
  const query = {
    select() {
      return query;
    },
    eq() {
      return query;
    },
    async maybeSingle() {
      return { data: { role: 'owner', active: true }, error: null };
    },
  };
  const actor = {
    user: { id: '20000000-0000-4000-8000-000000000001' },
    userDb: { from: () => query },
  } as unknown as Actor;
  const result = await dispatch(actor, 'admin.openrouter.status', { tenant }, env);
  assert.deepEqual(result, { configured: true, dailyLimit: 40, minuteLimit: 5 });
  assert.ok(!JSON.stringify(result).includes('synthetic-vault-value'));
  assert.deepEqual(await dispatch(actor, 'admin.openrouter.status', { tenant: crypto.randomUUID() }, env), {
    configured: false,
    dailyLimit: 40,
    minuteLimit: 5,
  });
});
test('unavailable Vault fails closed and returns no database/provider diagnostics', async () => {
  await assert.rejects(
    serverEnvironment(base, (async () =>
      Response.json({ message: 'sensitive synthetic diagnostic' }, { status: 503 })) as typeof fetch),
    /DATA_ERROR/,
  );
  const response = configUnavailable(new Error('sensitive synthetic diagnostic'));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { code: 'SERVER_NOT_CONFIGURED' });
});
