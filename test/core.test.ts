import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeText,
  boundedContext,
  chunkText,
  createAuthorityEngine,
  errorView,
  selectMemories,
  validateMemory,
} from '../packages/harness-core/src/index.ts';
import type { Memory } from '../packages/harness-core/src/contracts.ts';
import { calendarWindow, wantsCalendar } from '../supabase/functions/_shared/google.ts';
import { normalizeReceipt } from '../supabase/functions/_shared/receipt.ts';
test('shared context excludes personal memories, expired entries and unconfirmed proposals', () => {
  const entry = {
    id: '1',
    tenant_id: 't',
    owner_id: 'a',
    workspace_id: null,
    visibility: 'private',
    title: 'ภาษา',
    body: 'ตอบภาษาไทยกระชับ',
    kind: 'preference',
    confirmed: true,
    origin: 'manual',
    expires_at: null,
    created_at: '',
  } as Memory;
  const rows = [
    entry,
    { ...entry, id: '2', visibility: 'workspace' as const, workspace_id: 'w' },
    { ...entry, id: '3', confirmed: false },
    { ...entry, id: '4', expires_at: '2000-01-01' },
  ];
  assert.deepEqual(
    selectMemories(rows, 'ช่วยสรุป', 'workspace').map((m) => m.id),
    ['2'],
  );
  assert.deepEqual(
    selectMemories(rows, 'ช่วยสรุป', 'private').map((m) => m.id),
    ['1', '2'],
  );
});
test('memory rejects secrets and temporary run history before reuse', () => {
  assert.throws(() => validateMemory('ข้อมูล', 'password=synthetic-secret'), /SECRET_DETECTED/);
  assert.throws(() => validateMemory('งาน', 'PR #1234 ยังทำไม่เสร็จ'), /MEMORY_EPHEMERAL/);
  assert.deepEqual(validateMemory(' รูปแบบ ', ' ตอบสั้น '), { title: 'รูปแบบ', body: 'ตอบสั้น' });
  assert.throws(() => assertSafeText('-----BEGIN PRIVATE KEY-----'), /SECRET_DETECTED/);
  for (const key of ['sk-' + 's'.repeat(40), 'sk_live_' + 's'.repeat(24), 'ghp_' + 'g'.repeat(36)])
    assert.throws(() => assertSafeText(key), /SECRET_DETECTED/);
  assert.equal(assertSafeText('skill-authoring-standard'), 'skill-authoring-standard');
});
test('Thai context budget never drops the current query to fit optional references', () => {
  const result = boundedContext(['คำขอปัจจุบัน: ทดสอบ', 'ก'.repeat(60000)], 100);
  assert.equal(result, 'คำขอปัจจุบัน: ทดสอบ');
  const chunks = chunkText('ส่วนแรก '.repeat(800));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.content.length <= 1800));
});
test('authority factories use isolated organization rosters', () => {
  const first = createAuthorityEngine('executiveOversight:\n  - name: "คุณตัวอย่าง ทดสอบ"');
  const second = createAuthorityEngine('executiveOversight:\n  - name: "คุณสังเคราะห์ ทดสอบ"');
  const yaml =
    'authorities:\n  sign:\n    name: "ลงนาม"\n    authorizedRole: director\n    humanInTheLoop: mandatory\n    triggers: [ลงนามแทน]';
  assert.equal(
    first.evaluateAuthorityPreflight('ลงนามแทนให้เลย', first.parseAuthorityRegistry(yaml)).status,
    'BLOCK',
  );
  assert.equal(
    second.evaluateAuthorityPreflight('ช่วยสรุปเอกสาร', second.parseAuthorityRegistry(yaml)).status,
    'ALLOW',
  );
});
test('calendar ranges respect Bangkok midnight and Monday-to-Sunday next week', () => {
  const now = new Date('2026-10-25T18:00:00Z'); // Monday 01:00 in Bangkok.
  assert.deepEqual(calendarWindow('พรุ่งนี้', now), {
    timeMin: '2026-10-26T17:00:00.000Z',
    timeMax: '2026-10-27T17:00:00.000Z',
    timeZone: 'Asia/Bangkok',
  });
  assert.deepEqual(calendarWindow('อาทิตย์หน้า', new Date('2026-10-25T10:00:00Z')), {
    timeMin: '2026-10-25T17:00:00.000Z',
    timeMax: '2026-11-01T17:00:00.000Z',
    timeZone: 'Asia/Bangkok',
  });
});
test('meeting drafts and summaries do not unnecessarily request a personal Calendar connection', () => {
  for (const text of [
    'ช่วยร่างหนังสือเชิญประชุม',
    'สรุปบันทึกการประชุมจากไฟล์นี้',
    'prepare meeting minutes',
    'meeting summary',
  ])
    assert.equal(wantsCalendar(text), false, text);
  for (const text of [
    'อาทิตย์หน้ามีประชุมอะไรบ้าง',
    'พรุ่งนี้มีประชุมไหม',
    'ดู Google Calendar ให้หน่อย',
    'what meetings do I have next week?',
  ])
    assert.equal(wantsCalendar(text), true, text);
});
test('receipt validation overrides an optimistic model verdict for wrong buyer tax ID or uncertain signature', () => {
  const base = {
    document_type: 'full_tax_invoice',
    complete: 'complete',
    signature: 'uncertain',
    checks: [
      { field: 'เลขภาษีผู้ซื้อ', status: 'found', value: '0-9940-00423-17-9', evidence: '0-9940-00423-17-9' },
    ],
    next_steps: [],
    warnings: [],
  };
  assert.equal(normalizeReceipt(base).complete, 'uncertain');
  const mismatch = normalizeReceipt({
    ...base,
    signature: 'present',
    checks: [{ ...base.checks[0], value: '0994000423180' }],
  });
  assert.equal(mismatch.complete, 'incomplete');
  assert.equal(mismatch.checks[0].status, 'mismatch');
  assert.ok(mismatch.warnings.some((w) => w.includes('ตัวบุคคล')));
});
test('known recoverable errors do not instruct staff to retry permanent access problems', () => {
  for (const code of [
    'ACCESS_DENIED',
    'AI_NOT_CONFIGURED',
    'AI_QUOTA',
    'STORAGE_QUOTA',
    'GOOGLE_REAUTH_REQUIRED',
    'VERSION_CONFLICT',
  ])
    assert.equal(errorView(code).retry, false, code);
  assert.equal(errorView('NETWORK_ERROR').retry, true);
});
test('receipt cannot be marked complete when required fields or the buyer address are unverifiable', () => {
  const base = {
    document_type: 'full_tax_invoice',
    complete: 'complete',
    signature: 'present',
    checks: [
      {
        field: 'ที่อยู่ผู้ซื้อ',
        status: 'found',
        value: '155 หมู่ 2 แม่เหียะ เมือง เชียงใหม่ 99999',
        evidence: 'synthetic',
      },
    ],
    next_steps: [],
    warnings: [],
  };
  const result = normalizeReceipt(base);
  assert.equal(result.complete, 'uncertain');
  assert.equal(result.checks.find((c) => c.field === 'ที่อยู่ผู้ซื้อ')?.status, 'uncertain');
  assert.ok(result.checks.some((c) => c.field === 'เลขภาษีผู้ซื้อ' && c.status === 'uncertain'));
});
