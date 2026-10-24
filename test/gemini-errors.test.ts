import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gemini } from '../supabase/functions/_shared/gemini.ts';

// Synthetic key and prompt; no request leaves the process.
const env = (key: string) =>
  ({ GEMINI_API_KEY: 'synthetic-gemini-value', GEMINI_MODEL: 'gemini-synthetic-flash' })[key];
const answer = {
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'คำตอบสังเคราะห์' }] } }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
};
function provider(statuses: { count?: number[]; generate?: number[] }) {
  const calls: string[] = [];
  const fetcher = (async (url) => {
    const step = String(url).endsWith(':countTokens') ? 'count' : 'generate';
    calls.push(step);
    const status = statuses[step]?.shift() ?? 200;
    if (status !== 200) return new Response('{"error":{"status":"UNAVAILABLE"}}', { status });
    return Response.json(step === 'count' ? { totalTokens: 10 } : answer);
  }) as typeof fetch;
  return { client: gemini(env, fetcher), calls };
}
const generate = (client: ReturnType<typeof gemini>) =>
  client.generate({ system: 'กฎ', prompt: 'คำขอสังเคราะห์' });

test('an overloaded model (503) is retried once and the answer arrives', async () => {
  const { client, calls } = provider({ generate: [503] });
  assert.equal((await generate(client)).text, 'คำตอบสังเคราะห์');
  assert.deepEqual(calls, ['count', 'generate', 'generate']);
});

test('a model still busy after one retry reports AI_BUSY, not a configuration problem', async () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    const { client, calls } = provider({ count: [503, 503] });
    await assert.rejects(generate(client), /AI_BUSY/);
    assert.deepEqual(calls, ['count', 'count']);
  } finally {
    console.warn = warn;
  }
  // Only the step and status are logged: no prompt, answer or key.
  assert.deepEqual(
    warnings.map((w) => JSON.parse(w)),
    [{ provider: 'gemini', step: 'count', status: 503 }],
  );
  assert.ok(
    !warnings.join('').includes('synthetic-gemini-value') && !warnings.join('').includes('สังเคราะห์'),
  );
});

test('other failures are reported once, without a retry', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const [status, code] of [
      [500, /AI_BUSY/],
      [429, /AI_RATE_LIMIT/],
      [403, /AI_NOT_CONFIGURED/],
      [400, /AI_SERVICE_ERROR/],
    ] as const) {
      const { client, calls } = provider({ generate: [status] });
      await assert.rejects(generate(client), code);
      assert.deepEqual(calls, ['count', 'generate']);
    }
  } finally {
    console.warn = warn;
  }
});
