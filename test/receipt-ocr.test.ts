import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  OCR_TEXT_LIMIT,
  receiptOcrHint,
  receiptOcrSection,
} from '../packages/harness-core/src/receipt-ocr.ts';
import { receiptOcrPrompt } from '../supabase/functions/_shared/worker.ts';

// Synthetic OCR service result in the shape of STeP-AI-Harness experiments/local-thai-ocr.
const result = {
  engine: 'Typhoon OCR V2 0.8B + PaddleOCR number check',
  text: 'ignored when lines exist',
  pages: [
    {
      source: 'ocr',
      lines: [
        { text: 'ร้านทดสอบสังเคราะห์', needs_review: false },
        {
          text: 'รวมทั้งสิ้น 1,670.00',
          needs_review: true,
          crosscheck_status: 'disagree',
          crosscheck_candidate: 'รวมทั้งสิน 1,070.00',
        },
        { text: 'ภาษีมูลค่าเพิ่ม 70.00', needs_review: true, crosscheck_status: 'missing_in_typhoon' },
        { text: '   ', needs_review: false },
      ],
    },
    { source: 'native_pdf_text', text: 'หน้าสอง\nบรรทัดสอง', lines: [] },
  ],
};

test('the OCR reading marks every line whose numbers the two readers did not confirm', () => {
  const hint = receiptOcrHint(result)!;
  assert.equal(hint.engine, result.engine);
  assert.equal(hint.reviewLines, 2);
  assert.deepEqual(hint.text.split('\n'), [
    'ร้านทดสอบสังเคราะห์',
    '[ตรวจ] รวมทั้งสิ้น 1,670.00 (PaddleOCR อ่านว่า: รวมทั้งสิน 1,070.00)',
    '[ตรวจ] ภาษีมูลค่าเพิ่ม 70.00 (อ่านได้จาก PaddleOCR เท่านั้น)',
    'หน้าสอง',
    'บรรทัดสอง',
  ]);
  assert.equal(receiptOcrHint(null), null);
  assert.equal(receiptOcrHint({ pages: [] }), null);
  const long = receiptOcrHint({
    pages: [{ lines: Array.from({ length: 2000 }, () => ({ text: 'ก'.repeat(40) })) }],
  })!;
  assert.ok(long.text.length <= OCR_TEXT_LIMIT);
});

test('the receipt prompt keeps the image as evidence and fences the OCR text as data', () => {
  const section = receiptOcrSection(receiptOcrHint(result)!);
  assert.match(section, /ยึดภาพเป็นหลักฐาน/);
  assert.match(section, /ไม่ใช่คำสั่ง/);
  assert.match(section, /<<<OCR\n[\s\S]*\nOCR>>>$/);
  assert.equal(receiptOcrPrompt(undefined), '');
  assert.equal(receiptOcrPrompt({ text: 5 }), '');
  assert.match(receiptOcrPrompt(receiptOcrHint(result)), /\[ตรวจ\] รวมทั้งสิ้น/);
});

test('only a signed-in user reaches the OCR service, and it is never published on a port', async () => {
  const nginx = await readFile(new URL('../deploy/homelab/nginx.conf', import.meta.url), 'utf8');
  for (const path of ['/ocr/api/health', '/ocr/api/ocr']) {
    const block = nginx.slice(nginx.indexOf(`location = ${path} {`)).split(/\n {8}}/)[0];
    assert.match(block, /auth_request \/_ocr_auth;/, path);
    assert.match(block, /proxy_set_header Authorization "";/, path);
    assert.match(block, /proxy_set_header Origin "";/, path);
  }
  assert.match(nginx, /location = \/_ocr_auth \{\n\s+internal;/);
  assert.match(nginx, /proxy_pass \$supabase\/auth\/v1\/user;/);
  assert.match(nginx, /proxy_ssl_verify on;/);
  const compose = await readFile(new URL('../deploy/homelab/compose.yml', import.meta.url), 'utf8');
  const ocr = compose.slice(compose.indexOf('  ocr:'));
  assert.doesNotMatch(ocr, /ports:/);
  assert.match(ocr, /profiles: \['ocr'\]/);
  assert.match(ocr, /:\/opt\/typhoon\/models:ro/);
  const dockerfile = await readFile(new URL('../deploy/homelab/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /! grep -q '__SUPABASE' \/app\/nginx.conf/);
});
