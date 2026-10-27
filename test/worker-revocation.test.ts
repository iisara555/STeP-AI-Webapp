import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processOne } from '../supabase/functions/_shared/worker.ts';
import { aiService } from '../supabase/functions/_shared/ai.ts';
import { encrypt } from '../supabase/functions/_shared/crypto.ts';
import { prepareDocument } from '../packages/harness-core/src/desktop-workflows.ts';

// Every Supabase, Google and AI request is intercepted; only synthetic data is used.
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
}
async function fixture(
  kind: 'chat' | 'document' | 'receipt' = 'chat',
  input: {
    message?: string;
    skill?: string;
    registered?: boolean;
    documents?: boolean;
    autoSkillTriggers?: string[];
    sources?: { source_key: string; title: string; body: string; provenance?: Record<string, unknown> }[];
    skills?: { skill_key: string; title: string; description: string; instructions: string }[];
    history?: { role: string; body: string }[];
  } = {},
) {
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
      message: input.message ?? 'Please rewrite the synthetic example.',
      ...(input.skill ? { skill: input.skill } : {}),
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
    sources: [
      ...['__authority', '__organization'].map((source_key) => ({
        source_key,
        title: 'Synthetic registry',
        body: '',
        source_version: 'test',
        provenance: {},
      })),
      ...(input.sources || []).map((s) => ({
        ...s,
        source_version: 'test',
        provenance: { status: 'active', path: `docs/${s.source_key}.md`, ...s.provenance },
      })),
    ],
    skills: input.autoSkillTriggers
      ? [
          {
            id: crypto.randomUUID(),
            skill_key: 'synthetic-auto-skill',
            title: 'Synthetic auto Skill',
            description: '',
            instructions: 'SYNTHETIC_AUTO_SKILL_MARKER',
            metadata: { triggers: input.autoSkillTriggers },
            source_version: 'test',
          },
        ]
      : input.skill && input.registered !== false
        ? [
            {
              id: crypto.randomUUID(),
              skill_key: input.skill,
              title: 'Synthetic Skill',
              description: '',
              instructions: 'SYNTHETIC_SKILL_MARKER',
              metadata: {},
              source_version: 'test',
            },
          ]
        : (input.skills || []).map((s) => ({
            ...s,
            id: crypto.randomUUID(),
            metadata: {},
            source_version: 'test',
          })),
    documents: kind === 'chat' && input.documents !== false ? [doc] : [],
    document: kind === 'chat' ? null : doc,
    prepared_document:
      kind === 'receipt' ? { ...doc, id: crypto.randomUUID(), object_path: 'synthetic/derivative' } : null,
    history: [...(input.history || []), { role: 'user', body: input.message ?? '' }],
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

// TOR, memos and proposals mention budget or procurement, which used to trigger the "no STeP document" reply
// before the form's Skill was used, so the draft never reached the AI.
for (const [tool, variant] of [
  ['tor', 'service'],
  ['tor', 'goods'],
  ['memo', 'approval'],
  ['letter', 'external'],
  ['project', 'proposal'],
  ['minutes', 'minutes'],
] as const)
  test(`the ${tool} (${variant}) form draft reaches the AI with its Skill`, async () => {
    const work = prepareDocument(tool, {}, variant);
    const f = await fixture('chat', { message: work.message, skill: work.skillKey, documents: false });
    await f.run();
    assert.equal(f.state.sent.length, 2, 'countTokens and generateContent');
    assert.ok(
      f.state.sent.every((body) => body.includes('SYNTHETIC_SKILL_MARKER')),
      'the Skill is used',
    );
    assert.equal((f.state.finishes[0].answer as { text: string }).text, 'Synthetic answer');
  });

test('a Skill name that is not registered is not used, and the run is answered as general help', async () => {
  const work = prepareDocument('tor', {}, 'service');
  const f = await fixture('chat', {
    message: work.message,
    skill: 'not-a-registered-skill',
    registered: false,
    documents: false,
  });
  await f.run();
  assert.equal(f.state.sent.length, 2, 'countTokens and generateContent');
  assert.ok(f.state.sent.every((body) => !body.includes('SYNTHETIC_SKILL_MARKER')));
  assert.ok(f.state.sent.every((body) => body.includes('ไม่ได้อ้างอิงเอกสาร STeP')));
});

test('a STeP question with no matching document reaches the AI as general help that must not invent STeP facts', async () => {
  const f = await fixture('chat', { message: 'ขั้นตอนเบิกค่าเดินทางของ STeP', documents: false });
  await f.run();
  assert.equal(f.state.sent.length, 2, 'countTokens and generateContent');
  assert.ok(f.state.sent.every((body) => body.includes('ไม่ได้อ้างอิงเอกสาร STeP')));
  assert.ok(f.state.sent.every((body) => body.includes('ห้ามแต่งนโยบาย')));
  assert.equal((f.state.finishes[0].answer as { text: string }).text, 'Synthetic answer');
});

test('a creative STeP request with no document uses the auto-matched Skill', async () => {
  const f = await fixture('chat', {
    message:
      'คิด Big idea สำหรับงาน STeP Innovation Day 3 แนวทาง พร้อมชื่องาน key message และ signature moment',
    autoSkillTriggers: ['big idea'],
    documents: false,
  });
  await f.run();
  assert.equal(f.state.sent.length, 2, 'countTokens and generateContent');
  assert.ok(f.state.sent.every((body) => body.includes('SYNTHETIC_AUTO_SKILL_MARKER')));
  assert.ok(f.state.sent.every((body) => body.includes('ไม่ได้อ้างอิงเอกสาร STeP')));
  assert.equal((f.state.finishes[0].answer as { text: string }).text, 'Synthetic answer');
});

test('a run with organization context gets no general-help notice', async () => {
  const work = prepareDocument('tor', {}, 'service');
  const f = await fixture('chat', { message: work.message, skill: work.skillKey, documents: false });
  await f.run();
  assert.ok(f.state.sent.every((body) => !body.includes('ไม่ได้อ้างอิงเอกสาร STeP')));
});

// Desktop's tool loop opens a registered document the keyword search missed; the web asks the AI to choose once.
const leaveIndex = {
  source_key: 'synthetic-personnel-rules',
  title: 'หลักเกณฑ์งานบุคคลสังเคราะห์',
  body: [
    '# หลักเกณฑ์งานบุคคลสังเคราะห์',
    'ดัชนีสังเคราะห์สำหรับทดสอบ',
    '## หมวด 3 เงินเดือน',
    'SYNTHETIC_SALARY_MARKER',
    '## หมวด 4 การลาประเภทต่าง ๆ',
    '### 4.4 การลาพักผ่อนประจำปี',
    'SYNTHETIC_LEAVE_MARKER ลาพักผ่อนได้ 99 วันทำการ',
  ].join('\n'),
};
const policySkill = {
  skill_key: 'synthetic-policy-lookup',
  title: 'ตอบระเบียบสังเคราะห์',
  description: 'ใช้ตอบสิทธิตามระเบียบงานบุคคล',
  instructions: 'SYNTHETIC_POLICY_SKILL_MARKER',
};
function answers(...texts: string[]) {
  let call = 0;
  return (step: string) => {
    if (step !== 'generateContent') return;
    const text = texts[Math.min(call++, texts.length - 1)];
    return Response.json({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 },
    });
  };
}

test('a STeP question the keyword search misses is answered from the document section the AI chooses', async () => {
  const f = await fixture('chat', {
    message: 'ปีหน้าลางานได้กี่วัน',
    documents: false,
    sources: [leaveIndex],
    skills: [policySkill],
  });
  f.state.onRequest = answers(
    JSON.stringify({
      documents: [{ id: 'synthetic-personnel-rules', sections: ['หมวด 4 การลาประเภทต่าง ๆ'] }],
      skill: 'synthetic-policy-lookup',
    }),
    'Synthetic answer',
  );
  await f.run();
  assert.equal(f.state.sent.length, 4, 'choose (count + generate), then answer (count + generate)');
  assert.ok(f.state.sent[1].includes('synthetic-personnel-rules'), 'the AI chooses from the registry');
  const answer = f.state.sent[3];
  assert.ok(answer.includes('SYNTHETIC_LEAVE_MARKER'), 'the chosen chapter brings its clauses');
  assert.ok(!answer.includes('SYNTHETIC_SALARY_MARKER'), 'unchosen sections stay out');
  assert.ok(answer.includes('SYNTHETIC_POLICY_SKILL_MARKER'), 'the chosen Skill is used');
  assert.ok(!answer.includes('ไม่ได้อ้างอิงเอกสาร STeP'), 'an answer from a document is not general help');
  const finish = f.state.finishes[0];
  assert.deepEqual(
    (finish.answer as { sources: { id: string }[] }).sources.map((s) => s.id),
    ['synthetic-personnel-rules'],
  );
  assert.equal(finish.input_count, 200, 'both calls are counted');
});

test('a follow-up message is chosen with the earlier question', async () => {
  const f = await fixture('chat', {
    message: 'มีนะครับลองหาดู',
    documents: false,
    sources: [leaveIndex],
    history: [
      { role: 'user', body: 'ปีหน้าลางานได้กี่วัน' },
      { role: 'assistant', body: 'ยังไม่พบข้อมูล' },
    ],
  });
  f.state.onRequest = answers(
    JSON.stringify({
      documents: [{ id: 'synthetic-personnel-rules', sections: ['4.4 การลาพักผ่อนประจำปี'] }],
    }),
    'Synthetic answer',
  );
  await f.run();
  assert.ok(f.state.sent[1].includes('ปีหน้าลางานได้กี่วัน'));
  assert.ok(f.state.sent[3].includes('SYNTHETIC_LEAVE_MARKER'));
});

for (const choice of ['{"documents":[],"skill":null}', '{"documents":[{"id":"not-registered"}]}', 'not json'])
  test(`a STeP question stays general help when the AI chooses nothing usable (${choice})`, async () => {
    const f = await fixture('chat', {
      message: 'ขั้นตอนเบิกค่าเดินทางของ STeP',
      documents: false,
      sources: [leaveIndex],
    });
    f.state.onRequest = answers(choice, 'Synthetic answer');
    await f.run();
    assert.equal(f.state.sent.length, 4);
    assert.ok(f.state.sent[3].includes('ไม่ได้อ้างอิงเอกสาร STeP'));
    assert.ok(!f.state.sent[3].includes('SYNTHETIC_LEAVE_MARKER'));
  });

test('revocation while choosing references stops the run before the answer', async () => {
  const f = await fixture('chat', {
    message: 'ปีหน้าลางานได้กี่วัน',
    documents: false,
    sources: [leaveIndex],
  });
  f.state.onRequest = (step) => {
    if (step === 'countTokens') f.state.denied = 'ACCESS_DENIED';
  };
  const result = await f.run();
  assert.equal(f.state.sent.length, 1, 'the choice is not generated and nothing is answered');
  assert.ok('code' in result);
  assert.equal(f.state.finishes[0].answer, null);
  assert.equal(f.state.finishes[0].error, 'ACCESS_DENIED');
});
