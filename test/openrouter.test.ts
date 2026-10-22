import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openrouter } from '../supabase/functions/_shared/openrouter.ts';
import { dispatch } from '../supabase/functions/_shared/api.ts';
import type { Actor } from '../supabase/functions/_shared/runtime.ts';

const tenant = '10000000-0000-4000-8000-000000000001';
const trialEnv = (name: string) =>
  ({
    OPENROUTER_API_KEY: 'synthetic-secret-for-tests',
    OPENROUTER_TRIAL_TENANT_ID: tenant,
  })[name];
const model = {
  id: 'synthetic/example:free',
  name: 'Synthetic Free',
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  pricing: { prompt: '0', completion: '0', request: '0' },
};
const reply = {
  model: model.id,
  choices: [{ message: { content: 'คำตอบสังเคราะห์' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 8, cost: 0 },
};
function actor(
  role: string | null = 'owner',
  reservationError: string | null = null,
  revokeAfter = Infinity,
) {
  const reservations: unknown[] = [],
    tables: string[] = [];
  let checks = 0;
  const value = {
    user: { id: '20000000-0000-4000-8000-000000000001' },
    userDb: {
      from(table: string) {
        tables.push(table);
        assert.equal(table, 'tenant_members');
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          async maybeSingle() {
            checks++;
            return { data: role && checks <= revokeAfter ? { role, active: true } : null, error: null };
          },
        };
        return query;
      },
    },
    service: {
      async rpc(name: string, args: unknown) {
        assert.equal(name, 'reserve_openrouter_trial');
        reservations.push(args);
        return { data: null, error: reservationError ? { message: reservationError } : null };
      },
    },
  } as unknown as Actor;
  return { value, reservations, tables, checks: () => checks };
}
const input = () => ({
  tenant,
  model: model.id,
  prompt: 'ข้อมูลสมมติ',
  consent: true,
  requestId: crypto.randomUUID(),
});

test('OpenRouter catalog rejects paid variants, unknown pricing and extra fees', async () => {
  const entries = [
    model,
    { ...model, id: 'synthetic/paid' },
    { ...model, id: 'synthetic/charge:free', pricing: { prompt: '0', completion: '0', request: '0.1' } },
    { ...model, id: 'synthetic/missing:free', pricing: { prompt: '0' } },
    { ...model, id: 'synthetic/blank:free', pricing: { prompt: '', completion: '0' } },
    { ...model, id: 'synthetic/negative:free', pricing: { prompt: '-1', completion: '0' } },
    {
      ...model,
      id: 'synthetic/image:free',
      architecture: { input_modalities: ['image'], output_modalities: ['image'] },
    },
  ];
  const fetcher = (async () => Response.json({ data: entries })) as typeof fetch;
  assert.deepEqual(await openrouter(trialEnv, fetcher).models(), [{ id: model.id, name: model.name }]);
});
test('OpenRouter rechecks prices, caps every request at zero and sends only the consented prompt', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json(String(url).endsWith('/models') ? { data: [model] } : reply);
  }) as typeof fetch;
  const result = await openrouter(trialEnv, fetcher).generate(model.id, 'ข้อมูลสมมติ');
  assert.equal(result.text, 'คำตอบสังเคราะห์');
  assert.equal(result.cost, 0);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((r) => !r.url.includes('synthetic-secret')));
  const body = JSON.parse(String(requests[1].init?.body));
  assert.deepEqual(body.messages, [{ role: 'user', content: 'ข้อมูลสมมติ' }]);
  assert.deepEqual(body.provider, {
    allow_fallbacks: false,
    max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
  });
  assert.equal(body.max_tokens, 512);
  assert.equal(body.stream, false);
  assert.ok(!('models' in body) && !('tools' in body) && !('plugins' in body));
  const priceChanged = (async () =>
    Response.json({ data: [{ ...model, pricing: { prompt: '0.01', completion: '0' } }] })) as typeof fetch;
  await assert.rejects(
    openrouter(trialEnv, priceChanged).generate(model.id, 'สมมติ'),
    /OPENROUTER_FREE_ONLY/,
  );
});
test('OpenRouter errors discard diagnostics, never retry and do not fabricate missing cost', async () => {
  for (const [status, code] of [
    [401, 'KEY_INVALID'],
    [403, 'KEY_INVALID'],
    [402, 'CREDIT_REQUIRED'],
    [429, 'RATE_LIMIT'],
    [503, 'UNAVAILABLE'],
  ] as const) {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response('sensitive diagnostic', { status });
    }) as typeof fetch;
    await assert.rejects(
      openrouter(trialEnv, fetcher).models(),
      new RegExp('^Error: OPENROUTER_' + code + '$'),
    );
    assert.equal(calls, 1);
  }
  for (const invalid of [
    { ...reply, error: { message: 'sensitive' } },
    { ...reply, usage: { ...reply.usage, cost: 1 } },
    { ...reply, choices: [] },
    { ...reply, choices: [{ message: { content: null }, finish_reason: 'stop' }] },
  ]) {
    const fetcher = (async (url) =>
      Response.json(String(url).endsWith('/models') ? { data: [model] } : invalid)) as typeof fetch;
    await assert.rejects(
      openrouter(trialEnv, fetcher).generate(model.id, 'สมมติ'),
      /OPENROUTER_(RESPONSE_INVALID|COST_UNEXPECTED)/,
    );
  }
  const fetcher = (async (url) =>
    Response.json(
      String(url).endsWith('/models')
        ? { data: [model] }
        : { ...reply, usage: { prompt_tokens: 1, completion_tokens: 1 } },
    )) as typeof fetch;
  assert.equal((await openrouter(trialEnv, fetcher).generate(model.id, 'สมมติ')).cost, null);
});
test('trial rejects employees, nonmembers, other tenants, missing consent and secret text before provider access', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    throw new Error('must not call');
  }) as typeof fetch;
  for (const role of ['member', null]) {
    const a = actor(role);
    for (const action of ['admin.openrouter.status', 'admin.openrouter.models', 'admin.openrouter.test'])
      await assert.rejects(dispatch(a.value, action, input(), trialEnv, fetcher), /ACCESS_DENIED/);
    assert.equal(a.reservations.length, 0);
  }
  const a = actor();
  await assert.rejects(
    dispatch(
      a.value,
      'admin.openrouter.test',
      { ...input(), tenant: '10000000-0000-4000-8000-000000000002' },
      trialEnv,
      fetcher,
    ),
    /OPENROUTER_NOT_CONFIGURED/,
  );
  for (const invalid of [
    { ...input(), consent: false },
    { ...input(), model: 'synthetic/paid' },
    { ...input(), prompt: 'a'.repeat(4001) },
    { ...input(), documentIds: [crypto.randomUUID()] },
  ])
    await assert.rejects(dispatch(a.value, 'admin.openrouter.test', invalid, trialEnv, fetcher));
  await assert.rejects(
    dispatch(
      a.value,
      'admin.openrouter.test',
      { ...input(), prompt: 'api_key=synthetic-secret-value' },
      trialEnv,
      fetcher,
    ),
    /SECRET_DETECTED/,
  );
  assert.equal(calls, 0);
  assert.equal(a.reservations.length, 0);
});
test('trial works without paid Gemini budget, reserves once and rechecks admin access', async () => {
  const a = actor();
  const fetcher = (async (url) =>
    Response.json(String(url).endsWith('/models') ? { data: [model] } : reply)) as typeof fetch;
  const result = (await dispatch(a.value, 'admin.openrouter.test', input(), trialEnv, fetcher)) as {
    text: string;
  };
  assert.equal(result.text, 'คำตอบสังเคราะห์');
  assert.equal(a.reservations.length, 1);
  assert.equal(a.checks(), 3);
  assert.ok(a.tables.every((t) => t === 'tenant_members'));
  const revoked = actor('admin', null, 2);
  await assert.rejects(
    dispatch(revoked.value, 'admin.openrouter.test', input(), trialEnv, fetcher),
    /ACCESS_DENIED/,
  );
  for (const code of ['REQUEST_CONFLICT', 'OPENROUTER_RATE_LIMIT', 'ACCESS_DENIED']) {
    const denied = actor('admin', code);
    const noFetch = (async () => {
      throw new Error('must not call');
    }) as typeof fetch;
    await assert.rejects(
      dispatch(denied.value, 'admin.openrouter.test', input(), trialEnv, noFetch),
      new RegExp(code),
    );
  }
});
