import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../supabase/functions/_shared/api.ts';
import type { Actor } from '../supabase/functions/_shared/runtime.ts';
import { createWorker } from '../supabase/functions/_shared/worker.ts';
import { encrypt, decrypt } from '../supabase/functions/_shared/crypto.ts';
import { gemini } from '../supabase/functions/_shared/gemini.ts';
import { validFile } from '../supabase/functions/_shared/files.ts';
const env = (key: string) =>
  (
    ({
      APP_ORIGIN: 'https://app.example.test',
      GEMINI_API_KEY: 'synthetic-provider-value',
      WORKER_SECRET: 'synthetic-worker-proof',
    }) as Record<string, string>
  )[key];
test('API rejects other origins before authentication or dispatch', async () => {
  let called = false;
  const api = createApi(env, {
    authenticate: async () => {
      called = true;
      return {} as Actor;
    },
  });
  const response = await api(
    new Request('https://server.example.test', {
      method: 'POST',
      headers: { Origin: 'https://attacker.example.test' },
      body: '{}',
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(called, false);
});
test('API requires authentication and bounds request bodies', async () => {
  const api = createApi(env);
  const response = await api(
    new Request('https://server.example.test', {
      method: 'POST',
      headers: { Origin: 'https://app.example.test' },
      body: '{}',
    }),
  );
  assert.equal(response.status, 401);
  const authenticated = createApi(env, { authenticate: async () => ({}) as Actor });
  const large = await authenticated(
    new Request('https://server.example.test', { method: 'POST', body: 'a'.repeat(260000) }),
  );
  assert.equal((await large.json()).code, 'REQUEST_TOO_LARGE');
});
test('unexpected provider diagnostics never reach the employee response', async () => {
  const api = createApi(env, {
    authenticate: async () => ({}) as Actor,
    dispatch: async () => {
      throw new Error('sensitive synthetic provider diagnostic');
    },
  });
  const response = await api(
    new Request('https://server.example.test', {
      method: 'POST',
      body: JSON.stringify({ action: 'snapshot', input: {} }),
    }),
  );
  const body = await response.text();
  assert.equal(response.status, 500);
  assert.ok(!body.includes('sensitive synthetic'));
  assert.ok(body.includes('requestId'));
});
test('worker rejects an invalid dispatch credential without claiming any job', async () => {
  let claimed = false;
  const handler = createWorker(env, async () => {
    claimed = true;
    return {};
  });
  assert.equal(
    (
      await handler(
        new Request('https://worker.example.test', {
          method: 'POST',
          headers: { Authorization: 'Bearer invalid' },
        }),
      )
    ).status,
    403,
  );
  assert.equal(claimed, false);
  assert.equal(
    (
      await handler(
        new Request('https://worker.example.test', {
          method: 'POST',
          headers: { Authorization: 'Bearer synthetic-worker-proof' },
        }),
      )
    ).status,
    200,
  );
  assert.equal(claimed, true);
});
test('encrypted Google grants cannot be read under a different employee or tenant', async () => {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  const encrypted = await encrypt({ refresh_token: 'synthetic-google-refresh' }, key, 'tenant-a/user-a');
  assert.ok(!encrypted.includes('synthetic-google-refresh'));
  assert.deepEqual(await decrypt(encrypted, key, 'tenant-a/user-a'), {
    refresh_token: 'synthetic-google-refresh',
  });
  await assert.rejects(decrypt(encrypted, key, 'tenant-b/user-a'));
  await assert.rejects(decrypt(encrypted, key, 'tenant-a/user-b'));
});
test('Gemini countTokens uses the documented GenerateContentRequest for system instructions', async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (String(url).endsWith(':countTokens')) return Response.json({ totalTokens: 12 });
    return Response.json({
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ thought: true, text: 'private reasoning' }, { text: 'คำตอบที่แสดง' }] },
        },
      ],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 2 },
    });
  }) as typeof fetch;
  const result = await gemini(env, fetcher).generate({ system: 'system rule', prompt: 'ข้อความสังเคราะห์' });
  assert.equal(result.text, 'คำตอบที่แสดง');
  assert.equal(result.usage.output, 7);
  assert.deepEqual(Object.keys(requests[0].body), ['generateContentRequest']);
  assert.equal(
    (requests[0].body.generateContentRequest as Record<string, unknown>).model,
    'models/gemini-3.8-flash',
  );
  assert.ok(requests.every((r) => !r.url.includes('synthetic-provider-value')));
});
test('oversize input, malformed JSON and truncated OCR are not silently accepted', async () => {
  const tooLarge = (async () => Response.json({ totalTokens: 32001 })) as typeof fetch;
  await assert.rejects(
    gemini(env, tooLarge).generate({ system: 'rule', prompt: 'hello' }),
    /CONTEXT_TOO_LARGE/,
  );
  for (const body of [
    { candidates: [] },
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"partial"' }] } }] },
  ]) {
    let n = 0;
    const fetcher = (async () => Response.json(n++ === 0 ? { totalTokens: 10 } : body)) as typeof fetch;
    await assert.rejects(
      gemini(env, fetcher).generate({ system: 'rule', prompt: 'read receipt', json: true }),
      /PROVIDER_STREAM_INVALID/,
    );
  }
});
test('upload magic must match its declared file type', () => {
  assert.equal(validFile(new TextEncoder().encode('<html>synthetic</html>'), 'application/pdf'), false);
  assert.equal(validFile(new TextEncoder().encode('%PDF-1.7\nsynthetic'), 'application/pdf'), true);
  assert.equal(validFile(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png'), true);
  assert.equal(validFile(new TextEncoder().encode('<svg></svg>'), 'image/svg+xml'), false);
});
