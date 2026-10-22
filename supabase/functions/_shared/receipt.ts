import { z } from 'zod';
import { RECEIPT_BUYER } from '../../../packages/harness-core/src/index.ts';
export const receiptSchema = z.object({
  document_type: z.enum([
    'full_tax_invoice',
    'abbreviated_tax_invoice',
    'cash_bill',
    'general_receipt',
    'unknown',
  ]),
  complete: z.enum(['complete', 'incomplete', 'uncertain']),
  signature: z.enum(['present', 'absent', 'uncertain']),
  checks: z
    .array(
      z.object({
        field: z.string().max(100),
        status: z.enum(['found', 'missing', 'uncertain', 'mismatch']),
        value: z.string().max(2000).nullable(),
        evidence: z.string().max(2000).nullable(),
      }),
    )
    .min(1)
    .max(30),
  next_steps: z.array(z.string().max(1000)).max(15),
  warnings: z.array(z.string().max(1000)).max(15),
});
export function normalizeReceipt(input: unknown) {
  const result = receiptSchema.parse(input);
  const required: [string, RegExp][] = [
    ['วันที่', /วันที่|date/i],
    ['ชื่อผู้ขาย', /(?:ชื่อ.*ผู้ขาย|ผู้ขาย.*ชื่อ|seller.*name)/i],
    ['รายการสินค้า/บริการ', /รายการ|สินค้า|บริการ|items?/i],
    ['ยอดรวม', /ยอดรวม|จำนวนเงินรวม|total/i],
  ];
  if (result.document_type === 'full_tax_invoice')
    required.push(
      ['เลขที่เอกสาร', /เลขที่.*(?:เอกสาร|ใบ)|invoice.*(?:no|number)/i],
      ['เลขภาษีผู้ขาย', /(?:ผู้ขาย|seller).*(?:เลข|ภาษี|tax)|(?:เลข|ภาษี|tax).*(?:ผู้ขาย|seller)/i],
      ['ชื่อผู้ซื้อ', /(?:ชื่อ.*ผู้ซื้อ|ผู้ซื้อ.*ชื่อ|buyer.*name)/i],
      ['ที่อยู่ผู้ซื้อ', /(?:ที่อยู่.*ผู้ซื้อ|ผู้ซื้อ.*ที่อยู่|buyer.*address)/i],
      ['เลขภาษีผู้ซื้อ', /(?:ผู้ซื้อ|buyer).*(?:เลข|ภาษี|tax)|(?:เลข|ภาษี|tax).*(?:ผู้ซื้อ|buyer)/i],
    );
  for (const [field, match] of required)
    if (!result.checks.some((c) => match.test(c.field)))
      result.checks.push({ field, status: 'uncertain', value: null, evidence: null });
  for (const check of result.checks) {
    if (check.status === 'found' && !check.value?.trim() && !/ลายเซ็น|signature/i.test(check.field))
      check.status = 'uncertain';
    if (/(?:ผู้ซื้อ|STeP|buyer)/i.test(check.field) && /(?:เลข|ภาษี|tax)/i.test(check.field) && check.value) {
      if (check.value.replace(/\D/g, '') !== RECEIPT_BUYER.taxId) check.status = 'mismatch';
    }
    if (
      /(?:ผู้ซื้อ|STeP|buyer)/i.test(check.field) &&
      /(?:ที่อยู่|address)/i.test(check.field) &&
      check.value &&
      check.status === 'found'
    ) {
      const value = check.value.replace(/[\s.]/g, '');
      if (
        !/155(?!\d)/.test(value) ||
        !/(?:หมู่(?:ที่)?|ม)2(?!\d)/.test(value) ||
        !value.includes('แม่เหียะ') ||
        !value.includes('เมือง') ||
        !value.includes('เชียงใหม่') ||
        !value.includes('50100')
      )
        check.status = 'uncertain';
    }
  }
  if (result.checks.some((c) => c.status === 'mismatch' || c.status === 'missing'))
    result.complete = 'incomplete';
  else if (
    result.checks.some((c) => c.status === 'uncertain') ||
    result.signature !== 'present' ||
    result.document_type === 'unknown'
  )
    result.complete = 'uncertain';
  if (result.signature === 'present' && !result.warnings.some((w) => w.includes('ตัวบุคคล')))
    result.warnings.push('การพบลายเซ็นไม่ยืนยันตัวบุคคลหรืออำนาจลงนาม');
  return receiptSchema.parse(result);
}
