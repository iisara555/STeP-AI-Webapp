import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiService, modelClient, requireProviderConsent } from '../supabase/functions/_shared/ai.ts';
import { openrouterFree } from '../supabase/functions/_shared/openrouter-free.ts';
import { processOne } from '../supabase/functions/_shared/worker.ts';
import { dispatch } from '../supabase/functions/_shared/api.ts';
import type { Actor } from '../supabase/functions/_shared/runtime.ts';

const values: Record<string, string> = {
  AI_PROVIDER: 'openrouter_free',
  OPENROUTER_MODEL: 'synthetic/model:free',
  OPENROUTER_PROVIDER: 'synthetic',
  OPENROUTER_API_KEY: 'synthetic-provider-value',
  WORKER_SECRET: 'synthetic-worker-value',
  SUPABASE_URL: 'https://synthetic.supabase.co',
  SUPABASE_SECRET_KEY: 'synthetic-service-value',
};
const env = (key: string) => values[key];
const model = {
  id: values.OPENROUTER_MODEL,
  pricing: { prompt: '0', completion: '0' },
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  context_length: 64000,
};
test('provider identity includes model and upstream; invalid selection cannot fall back to paid Gemini', () => {
  const info = aiService(env);
  assert.equal(info.configured, true);
  assert.equal(info.textOnly, true);
  assert.ok(!JSON.stringify(info).includes(values.OPENROUTER_API_KEY));
  for (const overrides of [
    { OPENROUTER_MODEL: 'synthetic/paid' },
    { OPENROUTER_PROVIDER: '' },
    { AI_PROVIDER: 'unexpected', GEMINI_API_KEY: 'synthetic-gemini-value' },
  ]) {
    const changedValues: Record<string, string | undefined> = { ...values, ...overrides };
    const changed = (key: string) => changedValues[key];
    assert.equal(aiService(changed).configured, false);
    assert.throws(() => modelClient(changed), /AI_NOT_CONFIGURED/);
  }
  const changed = (key: string) => (key === 'OPENROUTER_PROVIDER' ? 'other' : env(key));
  assert.throws(() => requireProviderConsent(changed, info.consentId), /AI_PROVIDER_CHANGED/);
});
test('existing free worker client pins upstream, denies data collection and rejects nontext work', async () => {
  const requests: { url: string; body?: Record<string, unknown> }[] = [];
  const fetcher = (async (url, init) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json(
      String(url).endsWith('/models')
        ? { data: [model] }
        : {
            choices: [{ finish_reason: 'stop', message: { content: 'ข้อมูลสังเคราะห์' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 },
          },
    );
  }) as typeof fetch;
  const client = openrouterFree(env, fetcher);
  assert.equal((await client.generate({ system: 'rule', prompt: 'synthetic' })).text, 'ข้อมูลสังเคราะห์');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body?.provider, {
    only: ['synthetic'],
    allow_fallbacks: false,
    require_parameters: true,
    data_collection: 'deny',
    max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
  });
  assert.equal(requests[1].body?.model, model.id);
  await assert.rejects(client.embed('synthetic'), /AI_TRIAL_TEXT_ONLY/);
  await assert.rejects(
    client.generate({ system: 'rule', prompt: 'synthetic', json: true }),
    /AI_TRIAL_TEXT_ONLY/,
  );
  assert.equal(requests.length, 2);
  const priced = (async () =>
    Response.json({ data: [{ ...model, pricing: { prompt: '0.01', completion: '0' } }] })) as typeof fetch;
  await assert.rejects(
    openrouterFree(env, priced).generate({ system: 'rule', prompt: 'synthetic' }),
    /AI_FREE_UNAVAILABLE/,
  );
  for (const choice of [
    { finish_reason: 'length', message: { content: '' } },
    { finish_reason: 'stop', message: { content: null } },
  ]) {
    const empty = (async (url) =>
      Response.json(
        String(url).endsWith('/models')
          ? { data: [model] }
          : { choices: [choice], usage: { prompt_tokens: 10, completion_tokens: 4096, cost: 0 } },
      )) as typeof fetch;
    await assert.rejects(
      openrouterFree(env, empty).generate({ system: 'rule', prompt: 'synthetic' }),
      /^Error: AI_EMPTY_REPLY$/,
    );
  }
});
test('API rejects stale provider consent, nonadmin trials and OCR before creating a job', async () => {
  let role = 'owner';
  const query = {
    select() {
      return query;
    },
    eq() {
      return query;
    },
    async maybeSingle() {
      return { data: { role, active: true }, error: null };
    },
  };
  const actor = {
    user: { id: crypto.randomUUID() },
    userDb: {
      from: () => query,
      rpc: () => {
        throw new Error('must not create a job');
      },
    },
  } as unknown as Actor;
  const input = {
    tenant: crypto.randomUUID(),
    kind: 'chat',
    requestId: crypto.randomUUID(),
    consent: true,
    providerConsent: 'old',
  };
  await assert.rejects(dispatch(actor, 'run.start', input, env), /AI_PROVIDER_CHANGED/);
  input.providerConsent = aiService(env).consentId;
  await assert.rejects(
    dispatch(actor, 'run.start', { ...input, kind: 'receipt' }, env),
    /AI_TRIAL_TEXT_ONLY/,
  );
  role = 'member';
  await assert.rejects(dispatch(actor, 'run.start', input, env), /ACCESS_DENIED/);
});
test('worker refuses a provider change after admission without sending context upstream', async () => {
  const finished: Record<string, unknown>[] = [];
  const fetcher = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    assert.ok(String(url).startsWith('https://synthetic.supabase.co/rest/v1/rpc/'));
    if (path.endsWith('/claim_run'))
      return Response.json({
        id: crypto.randomUUID(),
        kind: 'chat',
        ai_provider: 'gemini',
        lease_token: crypto.randomUUID(),
        input: { providerConsent: 'stale-gemini-consent' },
      });
    if (path.endsWith('/worker_payload')) return Response.json({});
    assert.ok(path.endsWith('/finish_run'));
    finished.push(JSON.parse(String(init?.body)));
    return Response.json(true);
  }) as typeof fetch;
  const result = await processOne(env, fetcher);
  assert.equal(result.code, 'AI_PROVIDER_CHANGED');
  assert.equal(finished.length, 1);
  assert.equal(finished[0].error, 'AI_PROVIDER_CHANGED');
  assert.equal(finished[0].answer, null);
});
test('a free Gemini key is named, flagged and bound into consent; switching tiers needs new consent', () => {
  const gemini: Record<string, string> = {
    GEMINI_API_KEY: 'synthetic-gemini-value',
    GEMINI_MODEL: 'gemini-synthetic-flash',
    WORKER_SECRET: 'synthetic-worker-value',
  };
  const paid = aiService((key) => gemini[key]);
  const free = aiService((key) => ({ ...gemini, GEMINI_TIER: 'free' })[key]);
  assert.equal(paid.freeTier, false);
  assert.equal(free.freeTier, true);
  assert.equal(free.configured, true);
  assert.match(free.displayName, /รุ่นฟรี \(AI Studio\)/);
  assert.doesNotMatch(paid.displayName, /รุ่นฟรี/);
  assert.notEqual(free.consentId, paid.consentId);
  assert.ok(!JSON.stringify(free).includes(gemini.GEMINI_API_KEY));
  assert.throws(
    () => requireProviderConsent((key) => ({ ...gemini, GEMINI_TIER: 'free' })[key], paid.consentId),
    /AI_PROVIDER_CHANGED/,
  );
});
