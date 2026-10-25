import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processOne } from '../supabase/functions/_shared/worker.ts';
import { aiService } from '../supabase/functions/_shared/ai.ts';
import { encrypt } from '../supabase/functions/_shared/crypto.ts';

// Every Supabase, Google and AI request is intercepted; only synthetic data is used.
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
}
async function fixture(kind: 'chat' | 'document' | 'receipt' = 'chat') {
  const values: Record<string, string> = {
    SUPABASE_URL: 'https://synthetic.supabase.co',
    SUPABASE_SECRET_KEY: 'synthetic-service-value',
    GEMINI_API_KEY: 'synthetic-provider-value',
    WORKER_SECRET: 'synthetic-worker-value',
    CREDENTIAL_ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
  };
  const env = (key: string) => values[key];
  const job = {
    id: crypto.randomUUID(),
    tenant_id: crypto.randomUUID(),
    actor_id: crypto.randomUUID(),
    lease_token: crypto.randomUUID(),
    kind,
    ai_provider: 'gemini',
    input: {
      providerConsent: aiService(env).consentId,
      message: 'Please rewrite the synthetic example.',
      useMemory: true,
      documentIds: [] as string[],
    },
  };
  const doc = {
    id: crypto.randomUUID(),
    source_kind: kind === 'chat' ? 'drive' : 'upload',
    drive_file_id: 'synthetic-file',
    name: 'Synthetic selected file',
    object_path: 'synthetic/original',
    mime: 'image/png',
    extracted_text: kind === 'document' ? 'SYNTHETIC_EMBEDDING_MARKER' : '',
  };
  const context = {
    session: { visibility: 'private' },
    sources: ['__authority', '__organization'].map((source_key) => ({
      source_key,
      title: 'Synthetic registry',
      body: '',
      source_version: 'test',
      provenance: {},
    })),
    skills: [],
    documents: kind === 'chat' ? [doc] : [],
    document: kind === 'chat' ? null : doc,
    prepared_document:
      kind === 'receipt' ? { ...doc, id: crypto.randomUUID(), object_path: 'synthetic/derivative' } : null,
    history: [],
    memories: [
      {
        id: crypto.randomUUID(),
        title: 'Synthetic preference',
        body: 'SYNTHETIC_PRIVATE_MEMORY_MARKER prefer clear examples',
        kind: 'preference',
        visibility: 'private',
        confirmed: true,
        expires_at: null,
      },
    ],
  };
  job.input.documentIds = context.documents.map((d) => d.id);
  const ciphertext = await encrypt(
    {
      access_token: 'synthetic-google-access',
      refresh_token: 'synthetic-google-refresh',
      expires_at: Date.now() + 3600000,
    },
    values.CREDENTIAL_ENCRYPTION_KEY,
    `${job.tenant_id}/${job.actor_id}`,
  );
  const state = {
    denied: '',
    payloadReads: 0,
    events: [] as string[],
    sent: [] as string[],
    finishes: [] as Record<string, unknown>[],
    onRequest: undefined as undefined | ((step: string) => Promise<Response | void> | Response | void),
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const step = url.pathname.split('/').pop()!;
    state.events.push(step);
    if (url.hostname === 'synthetic.supabase.co') {
      if (step === 'claim_run') return Response.json(job);
      if (step === 'worker_payload') {
        state.payloadReads++;
        if (state.denied) return Response.json({ message: state.denied }, { status: 403 });
        await state.onRequest?.('worker-payload');
        return Response.json(context);
      }
      if (step === 'finish_run') {
        state.finishes.push(JSON.parse(String(init?.body)));
        return Response.json(!state.denied);
      }
      if (step === 'worker_user_context') return Response.json({ user_id: job.actor_id });
      if (step === 'read_google_grant')
        return Response.json({
          status: 'ready',
          scopes: ['https://www.googleapis.com/auth/drive.file'],
          ciphertext,
        });
      if (step === 'member_profiles') return Response.json(null);
      if (step === 'worker_store_document') return Response.json(null);
      if (url.pathname.startsWith('/storage/v1/object/')) {
        const response = await state.onRequest?.('storage');
        return response || new Response(new Uint8Array([137, 80, 78, 71]));
      }
    }
    if (url.hostname === 'www.googleapis.com' && step === 'synthetic-file') {
      if (!url.searchParams.has('alt')) {
        const response = await state.onRequest?.('drive-metadata');
        return response || Response.json({ id: 'synthetic-file', mimeType: 'text/plain' });
      }
      const response = await state.onRequest?.('drive-download');
      return response || new Response('SYNTHETIC_PRIVATE_DRIVE_MARKER example');
    }
    if (url.hostname === 'generativelanguage.googleapis.com') {
      const operation = step.split(':')[1];
      state.sent.push(String(init?.body));
      const response = await state.onRequest?.(operation);
      if (response) return response;
      if (operation === 'countTokens') return Response.json({ totalTokens: 100 });
      if (operation === 'embedContent') return Response.json({ embedding: { values: Array(768).fill(0.1) } });
      if (operation === 'generateContent')
        return Response.json({
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Synthetic answer' }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 },
        });
    }
    throw new Error(`Unexpected synthetic request: ${url.origin}${url.pathname}`);
  };
  return { context, state, run: () => processOne(env, fetcher) };
}

for (const denial of ['ACCESS_DENIED', 'RUN_INTERRUPTED'])
  test(`no AI disclosure when ${denial} occurs while Drive download is pending`, async () => {
    const f = await fixture();
    const downloading = barrier(),
      resume = barrier();
    f.state.onRequest = async (step) => {
      if (step === 'drive-download') {
        downloading.release();
        await resume.wait;
      }
    };
    const running = f.run();
    await downloading.wait;
    f.state.denied = denial;
    resume.release();
    const result = await running;
    assert.equal(f.state.sent.length, 0);
    assert.ok('code' in result);
    assert.equal(f.state.finishes.length, 1);
    assert.equal(f.state.finishes[0].answer, null);
  });

test('an accessible job sends its selected context once and commits normal usage', async () => {
  const f = await fixture();
  const result = await f.run();
  assert.ok('committed' in result && result.committed);
  assert.equal(f.state.sent.length, 2);
  assert.ok(f.state.sent.every((body) => body.includes('SYNTHETIC_PRIVATE_MEMORY_MARKER')));
  assert.ok(f.state.sent.every((body) => body.includes('SYNTHETIC_PRIVATE_DRIVE_MARKER')));
  assert.equal(f.state.finishes.length, 1);
  assert.equal(f.state.finishes[0].input_count, 100);
  assert.equal(f.state.finishes[0].output_count, 5);
});

test('removing selected context prevents sending an already assembled prompt', async () => {
  for (const removed of ['document', 'memory'] as const) {
    const f = await fixture();
    f.state.onRequest = (step) => {
      if (step === 'drive-download') {
        if (removed === 'document') f.context.documents = [];
        else f.context.memories = [];
      }
    };
    const result = await f.run();
    assert.equal(f.state.sent.length, 0, removed);
    assert.ok('code' in result);
    assert.equal(f.state.finishes[0].answer, null);
  }
});

test('cancellation between Drive metadata and download prevents the second Google read', async () => {
  const f = await fixture();
  let downloads = 0;
  f.state.onRequest = (step) => {
    if (step === 'drive-metadata') f.state.denied = 'RUN_INTERRUPTED';
    if (step === 'drive-download') downloads++;
  };
  const result = await f.run();
  assert.equal(downloads, 0);
  assert.equal(f.state.sent.length, 0);
  assert.ok('code' in result);
});

test('revocation after countTokens prevents generation and retains the failed reservation path', async () => {
  const f = await fixture();
  f.state.onRequest = (step) => {
    if (step === 'countTokens') f.state.denied = 'ACCESS_DENIED';
  };
  const result = await f.run();
  assert.equal(f.state.sent.length, 1);
  assert.ok('code' in result);
  assert.equal(f.state.finishes[0].answer, null);
  assert.equal(f.state.finishes[0].error, 'ACCESS_DENIED');
});

for (const operation of ['countTokens', 'generateContent', 'embedContent'])
  test(`revocation during the ${operation} 503 backoff prevents a retry`, async () => {
    const f = await fixture(operation === 'embedContent' ? 'document' : 'chat');
    let attempts = 0;
    f.state.onRequest = (step) => {
      if (step === operation && ++attempts === 1) {
        setTimeout(() => (f.state.denied = 'ACCESS_DENIED'), 50);
        return new Response('Synthetic busy response', { status: 503 });
      }
    };
    const result = await f.run();
    assert.equal(attempts, 1);
    assert.ok('code' in result);
    assert.equal(f.state.finishes[0].answer, null);
  });

test('removing the selected receipt derivative during download prevents its later disclosure', async () => {
  const f = await fixture('receipt');
  f.state.onRequest = (step) => {
    if (step === 'storage') f.context.prepared_document = null;
  };
  const result = await f.run();
  assert.equal(f.state.sent.length, 0);
  assert.ok('code' in result);
  assert.equal(f.state.finishes[0].answer, null);
});

test('cancellation before the receipt read prevents service-role Storage access', async () => {
  const f = await fixture('receipt');
  let downloads = 0;
  f.state.onRequest = (step) => {
    if (step === 'worker-payload' && f.state.payloadReads === 1) f.state.denied = 'RUN_INTERRUPTED';
    if (step === 'storage') downloads++;
  };
  const result = await f.run();
  assert.equal(downloads, 0);
  assert.equal(f.state.sent.length, 0);
  assert.ok('code' in result);
});
