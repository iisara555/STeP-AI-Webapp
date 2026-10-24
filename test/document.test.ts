import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatSystem,
  documentContext,
  documentOutputTokens,
  pointerTargets,
} from '../packages/harness-core/src/document-context.ts';
import { skillContext, type RegisteredSource } from '../packages/harness-core/src/skill-context.ts';
import { SYSTEM_RULES } from '../packages/harness-core/src/index.ts';
import type { Skill } from '../packages/harness-core/src/contracts.ts';
import { aiService } from '../supabase/functions/_shared/ai.ts';
import { processOne } from '../supabase/functions/_shared/worker.ts';

const support = (key: string, path: string, body: string): RegisteredSource => ({
  source_key: key,
  title: path.split('/').slice(-2).join('/'),
  body,
  source_version: 'synthetic',
  provenance: { kind: 'skill-support', path },
});
const central = support(
  'support-central',
  'skills/common/thai-official-documents/templates/tor-16-sections-template.md',
  '# Working template — synthetic sixteen sections',
);
const pointer = support(
  'support-pointer',
  'skills/pm/tor-government-writing/templates/tor-16-sections-template.md',
  '# แม่แบบ TOR — ใช้แหล่งกลางเดียว\nแม่แบบอยู่ที่ [กลาง](../../../common/thai-official-documents/templates/tor-16-sections-template.md)',
);
const checks = support(
  'support-checks',
  'skills/common/thai-official-documents/references/drafting-checks.md',
  '# synthetic drafting checks',
);
const registered = [central, pointer, checks];
const skill = (key: string, support: string[] = []): Skill =>
  ({
    id: key,
    skill_key: key,
    title: key,
    description: '',
    instructions: `synthetic instructions for ${key}`,
    metadata: { support_source_keys: support, required_source_keys: [] },
    source_version: 'synthetic',
  }) as unknown as Skill;
const skills = [skill('tor-government-writing', ['support-pointer']), skill('thai-official-documents')];

test('a pointer file resolves to the central copy it names', () => {
  assert.deepEqual(pointerTargets(pointer, registered), [central]);
  assert.deepEqual(pointerTargets(central, registered), []);
});

test('TOR drafting loads the supporting Skill, the real template and references, and names what is missing', () => {
  const { parts, sources } = documentContext('tor', skills, registered);
  const text = parts.join('\n');
  assert.match(text, /Skill ร่วม .*thai-official-documents/);
  assert.match(text, /synthetic instructions for thai-official-documents/);
  assert.match(text, /synthetic sixteen sections/);
  assert.match(text, /synthetic drafting checks/);
  assert.ok(sources.some((s) => s.id === 'support-central'));
  // References the Harness pack does not contain stay visible gaps for the review, never invented content.
  assert.match(text, /ยังไม่มีในระบบ: .*thai-layout\.md/);
});

test('a Skill pointer file brings its central copy into context', () => {
  const { parts } = skillContext(skills[0], registered, 'ร่าง TOR');
  assert.match(parts.join('\n'), /synthetic sixteen sections/);
});

test('the drafting contract sits between organization rules and personal preferences', () => {
  const system = chatSystem(SYSTEM_RULES, 'tor', 'Personal preferences (synthetic)');
  assert.ok(system.startsWith(SYSTEM_RULES));
  assert.ok(system.indexOf('<document_tool_contract>') < system.indexOf('Personal preferences'));
  assert.match(system, /Return exactly two separate blocks: <document_draft>/);
  assert.equal(chatSystem(SYSTEM_RULES), SYSTEM_RULES);
});

test('longer document answers never cost more than the run reserved', () => {
  for (const [reserved, input, output] of [
    [7, 75, 375],
    [12, 150, 750],
    [3, 30, 250],
  ]) {
    const tokens = documentOutputTokens(reserved, input, output);
    assert.ok(tokens >= 4096 && tokens <= 8192);
    if (tokens > 4096) assert.ok(Math.ceil((32000 * input + tokens * output) / 1_000_000) <= reserved);
  }
  assert.equal(documentOutputTokens(7, 75, 375), 8192);
  assert.equal(documentOutputTokens(0, 0, 0), 4096);
});

test('a TOR request with a Skill reaches the model with its contract instead of the missing-source reply', async () => {
  const values: Record<string, string> = {
    GEMINI_API_KEY: 'synthetic-gemini-value',
    GEMINI_MODEL: 'gemini-synthetic-flash',
    WORKER_SECRET: 'synthetic-worker-value',
    SUPABASE_URL: 'https://synthetic.supabase.co',
    SUPABASE_SECRET_KEY: 'synthetic-service-value',
  };
  const env = (key: string) => values[key];
  const draft =
    '<document_draft>\n# ขอบเขตของงาน\n</document_draft>\n<document_review>\nตรวจ\n</document_review>';
  let generation: Record<string, any> | undefined;
  const finished: Record<string, any>[] = [];
  const fetcher = (async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith('/rpc/claim_run'))
      return Response.json({
        id: crypto.randomUUID(),
        kind: 'chat',
        ai_provider: 'gemini',
        lease_token: crypto.randomUUID(),
        tenant_id: crypto.randomUUID(),
        actor_id: crypto.randomUUID(),
        input: {
          providerConsent: aiService(env).consentId,
          message: 'ร่าง TOR (จ้างงาน / บริการ) งบประมาณ [รอยืนยัน]',
          skill: 'tor-government-writing',
          documentTool: 'tor',
          useMemory: false,
        },
      });
    if (target.pathname.endsWith('/rpc/worker_payload'))
      return Response.json({
        run: { reserved_cents: 7, input_rate: 75, output_rate: 375 },
        session: { visibility: 'private', draft: '' },
        sources: [
          { source_key: '__authority', title: '', body: '', source_version: '', provenance: {} },
          { source_key: '__organization', title: '', body: '', source_version: '', provenance: {} },
          ...registered,
        ],
        skills,
        memories: [],
        documents: [],
        history: [{ role: 'user', body: 'ร่าง TOR' }],
      });
    if (target.pathname.endsWith('/member_profiles')) return Response.json([]);
    if (target.pathname.endsWith(':countTokens')) return Response.json({ totalTokens: 1200 });
    if (target.pathname.endsWith(':generateContent')) {
      generation = JSON.parse(String(init?.body));
      return Response.json({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: draft }] } }],
        usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300 },
      });
    }
    if (target.pathname.endsWith('/rpc/finish_run')) {
      finished.push(JSON.parse(String(init?.body)));
      return Response.json(true);
    }
    return Response.json(true);
  }) as typeof fetch;
  await processOne(env, fetcher);
  assert.ok(generation, 'the model was called rather than the missing-source reply');
  const system = generation.systemInstruction.parts[0].text;
  assert.match(system, /<document_tool_contract>/);
  assert.equal(generation.generationConfig.maxOutputTokens, 8192);
  assert.match(generation.contents[0].parts[0].text, /synthetic sixteen sections/);
  assert.equal(finished[0].error, null);
  assert.equal(finished[0].answer.text, draft);
});
