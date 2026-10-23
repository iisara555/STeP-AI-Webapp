import { documentTool, type DocumentToolId } from './document-tools.ts';

export type DocumentOutput = { draft: string; review: string };
const OUTPUT_TAG = /<\/?document_(?:draft|review)\b[^>]*>/gi;
const REVIEW_HEADING =
  /^(?:ตรวจข้อมูล(?:และแหล่งที่ขาด)?(?:ก่อนเสนอ)?|ผลตรวจ(?:ร่าง|เอกสาร|รูปแบบ)?|ตารางผลตรวจ|ตารางการตรวจสอบความสอดคล้องตามมาตรฐานงานสารบรรณ|รายการข้อมูลที่ต้องยืนยัน(?:เพิ่มเติม)?(?:ก่อนเสนองาน)?|ข้อมูลที่ต้องยืนยัน|ประเด็นค้าง\s*\/\s*ตรวจข้อมูล|Skill Verification|Unresolved Fields|Next Steps)(?:\s|\(|$)/i;

// A chat opener ("ได้ครับ ผมแก้ไขให้แล้วดังนี้") or closer ("หากต้องการปรับเพิ่มบอกได้เลยครับ") around a document.
const OPENER = /^(?:ได้ครับ|ได้ค่ะ|ได้เลย|นี่คือ|ต่อไปนี้|จัดทำร่าง|แน่นอน|ผม(?:ได้)?(?:แก้|ปรับ)|ดิฉัน(?:ได้)?(?:แก้|ปรับ))/;
const CLOSER =
  /^(?:(?:หาก|ถ้า)(?:ต้องการ|มี|อยาก)[^\n]*(?:บอก|แจ้ง|ปรับ|แก้|ช่วย)|หวังว่า|ยินดี(?:ช่วย|ปรับ|แก้)|มีอะไรให้ช่วย|ต้องการให้(?:ผม|ดิฉัน))/;

function separateLegacy(text: string): DocumentOutput {
  const lines = text.split('\n');
  let start = lines.findIndex(line => /^\s*#{1,3}\s+(?:ร่าง|บันทึกข้อความ|รายงานการประชุม|ขอบเขตของงาน|ข้อเสนอโครงการ)/.test(line));
  if (start <= 0) start = lines.findIndex(line => /^\s*#{1,3}\s+\S/.test(line));
  // A later document-like heading is not permission to discard real opening paragraphs or tables.
  const preface = start > 0 && lines.slice(0, start).every(line => !line.trim() || OPENER.test(line.trim()));
  const from = preface ? start : 0;
  const check = lines.findIndex(
    (line, index) =>
      index > from &&
      REVIEW_HEADING.test(
        line
          .replace(/^\s*#{1,6}\s+/, '')
          .replace(/^\*\*(.*?)\*\*$/, '$1')
          .trim(),
      ),
  );
  // A closing offer after the document belongs to the review too.
  let end = check < 0 ? lines.length : check;
  let tail = end;
  while (tail > from && (!lines[tail - 1].trim() || CLOSER.test(lines[tail - 1].trim()))) tail--;
  if (lines.slice(tail, end).some(line => CLOSER.test(line.trim()))) end = tail;
  return {
    draft: lines.slice(from, end).join('\n').trim(),
    review: [...lines.slice(0, from), ...lines.slice(end, check < 0 ? undefined : check), ...(check < 0 ? [] : lines.slice(check))]
      .join('\n')
      .trim(),
  };
}

/** A document and its source/authority checks are different deliverables. Never drop the latter. */
export function parseDocumentOutput(output: string, id: DocumentToolId, options: { requireEnvelope?: boolean } = {}): DocumentOutput {
  if (!documentTool(id)) throw new Error('INVALID_DOCUMENT_TOOL');
  const text = output.replace(/\r\n?/g, '\n').trim();
  let draft = '',
    review = '';
  const tags = [...text.matchAll(OUTPUT_TAG)].map(m => m[0]);
  // Fresh AI responses must satisfy the trusted contract. Legacy saved proposals remain readable.
  if (options.requireEnvelope && tags.length !== 4) throw new Error('DOCUMENT_OUTPUT_INVALID');
  if (tags.length) {
    const expected = ['<document_draft>', '</document_draft>'];
    if (tags.length === 4) expected.push('<document_review>', '</document_review>');
    if (tags.length !== expected.length || tags.some((tag, index) => tag !== expected[index])) throw new Error('DOCUMENT_OUTPUT_INVALID');
    const body = /<document_draft>([\s\S]*?)<\/document_draft>/.exec(text)!;
    const separated = separateLegacy(body[1].trim());
    draft = separated.draft;
    // Surrounding explanations belong to review too, even when a model ignores the no-preface rule.
    review = [
      separated.review,
      text
        .replace(body[0], '')
        .replace(/<\/?document_review>/g, '')
        .replace(/^\s*```(?:markdown|xml)?\s*$/gm, '')
        .trim(),
    ]
      .filter(Boolean)
      .join('\n\n');
  } else {
    // Existing saved proposals and providers without envelopes: split only explicit review headings.
    ({ draft, review } = separateLegacy(text));
  }
  if (!draft) throw new Error('DOCUMENT_OUTPUT_INVALID');
  if (
    REVIEW_HEADING.test(
      draft
        .split('\n')[0]
        .replace(/^\s*#{1,6}\s+/, '')
        .trim(),
    )
  )
    throw new Error('DOCUMENT_OUTPUT_INVALID');
  // The draft's review status belongs in the application, not in an official title.
  if (id === 'memo') draft = draft.replace(/^(?:#{1,3}[ \t]+)?(?:ร่าง[^\n]*[—–-][ \t]*)?บันทึกข้อความ[ \t]*(?=\n|$)/, '# บันทึกข้อความ');
  if (id === 'letter')
    draft = draft.replace(/^#{1,3}\s+(?:ร่างเพื่อพิจารณา(?:\s*[—–-]\s*หนังสือราชการ)?|ร่างหนังสือราชการ)\s*\n/, '').trim();
  return { draft, review };
}
