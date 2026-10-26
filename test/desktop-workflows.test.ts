import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOCUMENT_TOOLS,
  prepareDocument,
  literalSearch,
} from '../packages/harness-core/src/desktop-workflows.ts';
import { compileMedia, normalizeMedia } from '../packages/harness-core/vendor/desktop/internal-media.ts';
import { skillContext, type RegisteredSource } from '../packages/harness-core/src/skill-context.ts';
import { DESKTOP_BASELINE, DESKTOP_FEATURES } from '../packages/harness-core/src/desktop-reference.ts';
import type { Skill } from '../packages/harness-core/src/contracts.ts';
import { skillSupport } from '../scripts/harness-support.mjs';
import { dispatch } from '../supabase/functions/_shared/api.ts';
import type { Actor } from '../supabase/functions/_shared/runtime.ts';

test('all five document profiles retain source values and unresolved facts in a bounded consent-ready request', () => {
  assert.equal(DOCUMENT_TOOLS.length, 5);
  for (const tool of DOCUMENT_TOOLS)
    for (const variant of tool.variants) {
      const key = tool.fields[0].key;
      const work = prepareDocument(tool.id, { [key]: 'ข้อมูลสังเคราะห์' }, variant.id);
      assert.ok(work.draft.includes('ข้อมูลสังเคราะห์'));
      assert.ok(work.draft.includes('[รอยืนยัน:'));
      assert.ok(work.message.includes('USER_INPUT'));
      assert.ok(work.message.includes(tool.template));
      assert.equal(work.skillKey, tool.skill);
    }
  const tor = prepareDocument('tor', {}, 'service');
  assert.match(tor.message, /อุทยานวิทยาศาสตร์และเทคโนโลยี มหาวิทยาลัยเชียงใหม่/);
  assert.match(tor.message, /อาคาร A ชั้น 2 อาคารอำนวยการอุทยานวิทยาศาสตร์ภูมิภาค/);
  assert.throws(() => prepareDocument('tor', { invented: 'ข้อมูล' }, 'service'), /INVALID_DOCUMENT_FIELDS/);
  assert.throws(() => prepareDocument('memo', { subject: 'x'.repeat(6001) }, 'approval'), /INPUT_LIMIT/);
});
test('media keeps unsupported claims and unfinished guides out of copy-ready prompts', () => {
  const empty = compileMedia(normalizeMedia({ type: 'GUIDE', topic: 'ตัวอย่าง' }));
  assert.equal(empty.ready, false);
  assert.ok(empty.missing.includes('ขั้นตอนใช้งานจริง'));
  const prompt = compileMedia(
    normalizeMedia({ topic: 'งานตัวอย่าง', brief: 'ภาพประกอบสมมติ', content: 'ข้อความตัวอย่าง' }),
  );
  assert.equal(prompt.ready, true);
  assert.match(prompt.prompt, /#FFC709/);
  assert.match(prompt.prompt, /Never generate, redraw or imitate ANY logo/);
  assert.equal(compileMedia(normalizeMedia({ topic: '[รอยืนยัน]' })).ready, false);
});
test('Skill context retains full mandatory references, exposes missing sources and bounds working examples', () => {
  const skill: Skill = {
    id: 'synthetic',
    skill_key: 'sample',
    title: 'ทดสอบ',
    description: '',
    instructions: 'วิธีทำงาน',
    source_version: 'test',
    metadata: { required_source_keys: ['rule', 'missing'], support_source_keys: ['support'] },
  };
  const sources: RegisteredSource[] = [
    {
      source_key: 'rule',
      title: 'กฎ',
      body: 'กฎที่ต้องเก็บครบ '.repeat(500) + 'TAIL-MARKER',
      source_version: 'test',
      provenance: {},
    },
    {
      source_key: 'support',
      title: 'ตัวอย่าง',
      body: 'ข้อมูลตัวอย่าง '.repeat(1000),
      source_version: 'test',
      provenance: { kind: 'skill-support', path: 'skills/sample/templates/example.md' },
    },
  ];
  const context = skillContext(skill, sources, 'ข้อมูลตัวอย่าง');
  assert.match(context.parts.join('\n'), /TAIL-MARKER/);
  assert.match(context.parts.join('\n'), /ยังไม่มีต้นฉบับ: missing/);
  assert.match(context.parts.join('\n'), /ไม่ใช่ข้อกำหนดที่ได้รับอนุมัติ/);
  assert.match(context.parts.join('\n'), /แสดงข้อความบางส่วน/);
  assert.throws(
    () => skillContext(skill, [{ ...sources[0], body: 'ไทย '.repeat(60000) }], 'คำถาม'),
    /CONTEXT_LIMIT/,
  );
});
test('literal search escapes SQL wildcards and does not interpolate PostgREST expression syntax', () => {
  assert.equal(literalSearch('50%_\\,(x)'), '%50\\%\\_\\\\,(x)%');
  assert.throws(() => literalSearch(' '), /INVALID_REQUEST/);
});
test('support export excludes retired files and executable content and refuses symlinks and secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'step-support-'));
  try {
    await mkdir(join(root, 'skills/sample/references'), { recursive: true });
    const folder = join(root, 'skills/sample/references');
    await writeFile(join(folder, 'reference.md'), 'ข้อมูลสังเคราะห์');
    await writeFile(join(folder, 'restricted.md'), 'ห้ามนำเข้า');
    await writeFile(join(folder, 'run.js'), 'do not execute');
    const rows = await skillSupport(
      root,
      'skills/sample',
      new Set(['skills/sample/references/restricted.md']),
    );
    assert.deepEqual(
      rows.map((r) => r.path),
      ['skills/sample/references/reference.md'],
    );
    await symlink(join(root, 'outside'), join(folder, 'link.md'));
    await assert.rejects(skillSupport(root, 'skills/sample'), /SUPPORT_SYMLINK/);
    await rm(join(folder, 'link.md'));
    await writeFile(join(folder, 'secret.md'), 'sk-' + 's'.repeat(40));
    await assert.rejects(skillSupport(root, 'skills/sample'), /SECRET_DETECTED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('Desktop inventory accounts for every recorded renderer module without importing its contents', async () => {
  const inventory = JSON.parse(await readFile('docs/desktop-inventory.json', 'utf8'));
  assert.equal(inventory.sourceCommit, DESKTOP_BASELINE.commit);
  assert.equal(inventory.modules.length, 91);
  assert.equal(new Set(DESKTOP_FEATURES.map((f) => f.id)).size, DESKTOP_FEATURES.length);
  for (const module of inventory.modules)
    assert.ok(
      module.features.every((id: string) =>
        DESKTOP_FEATURES.some((f) => f.id === id && f.sources.includes(module.path)),
      ),
    );
});
test('history API uses tenant-scoped user queries only and refuses membership before searching', async () => {
  const tenant = crypto.randomUUID(),
    session = crypto.randomUUID();
  let allowed = true;
  const calls: { table: string; filters: unknown[][] }[] = [];
  const actor = {
    user: { id: crypto.randomUUID() },
    service: new Proxy(
      {},
      {
        get() {
          throw new Error('must not use service access');
        },
      },
    ),
    userDb: {
      from(table: string) {
        const call = { table, filters: [] as unknown[][] };
        calls.push(call);
        const q = {
          select() {
            return q;
          },
          eq(...args: unknown[]) {
            call.filters.push(['eq', ...args]);
            return q;
          },
          ilike(...args: unknown[]) {
            call.filters.push(['ilike', ...args]);
            return q;
          },
          in() {
            return q;
          },
          order() {
            return q;
          },
          limit() {
            return q;
          },
          async maybeSingle() {
            return { data: allowed ? { role: 'member', active: true } : null, error: null };
          },
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({
              data: table === 'messages' ? [{ session_id: session }] : [{ id: session }],
              error: null,
            }).then(resolve);
          },
        };
        return q;
      },
    },
  } as unknown as Actor;
  const rows = await dispatch(actor, 'session.search', { tenant, query: '50%' }, () => undefined);
  assert.equal(rows.length, 1);
  for (const call of calls) assert.ok(call.filters.some((f) => f[1] === 'tenant_id' && f[2] === tenant));
  assert.ok(
    calls
      .filter((c) => c.filters.some((f) => f[0] === 'ilike'))
      .every((c) => c.filters.some((f) => f[0] === 'ilike' && f[2] === '%50\\%%')),
  );
  calls.length = 0;
  allowed = false;
  await assert.rejects(
    dispatch(actor, 'session.search', { tenant, query: 'private' }, () => undefined),
    /ACCESS_DENIED/,
  );
  assert.deepEqual(
    calls.map((c) => c.table),
    ['tenant_members'],
  );
});
