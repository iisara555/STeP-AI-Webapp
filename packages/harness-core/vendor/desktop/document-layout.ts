import { documentTool, type DocumentToolId } from './document-tools.ts';
import { documentText, type DraftNode } from './draft.ts';

// These are working layouts, not a certification of a current agency form.
export const DOCUMENT_FONTS = ['TH SarabunPSK', 'TH Sarabun New'] as const;
export type DocumentFont = (typeof DOCUMENT_FONTS)[number];
export type DocumentLayout = { id?: DocumentToolId; font: DocumentFont; garudaHeightCm?: 1.5 | 3 };
export function resolveDocumentLayout(id?: unknown, font?: unknown, garuda?: unknown): DocumentLayout {
  if (font === 'TH Sarabun PSK') font = 'TH SarabunPSK';
  const profile = id === undefined ? undefined : documentTool(id);
  if (id !== undefined && !profile) throw new Error('INVALID_DOCUMENT_TOOL');
  if (font !== undefined && !DOCUMENT_FONTS.includes(font as DocumentFont)) throw new Error('INVALID_EXPORT_FONT');
  if (garuda !== undefined && garuda !== 'auto' && garuda !== 'none') throw new Error('INVALID_EXPORT_GARUDA');
  return {
    id: profile?.id,
    font: (font as DocumentFont | undefined) || (profile && profile.id !== 'memo' ? 'TH SarabunPSK' : 'TH Sarabun New'),
    ...(garuda !== 'none' && ['memo', 'letter'].includes(profile?.id || '') ? { garudaHeightCm: profile?.id === 'memo' ? 1.5 : 3 } : {}),
  };
}

export type LayoutRole = 'title' | 'subject' | 'front' | 'sender' | 'date' | 'memo-reference' | 'signature' | 'field' | 'body';
const THAI_MONTHS = 'มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม';
/** A bare หนังสือภายนอก date line, e.g. "๑๘ พฤศจิกายน ๒๕๖๙"; the label "วันที่" is optional. */
const LETTER_DATE = new RegExp(`^(?:วันที่\\s+)?[0-9๐-๙]{1,2}\\s+(?:${THAI_MONTHS})\\s+(?:พ\\.ศ\\.\\s*)?[0-9๐-๙]{4}$`);
const LETTER_FIELD = /^(?:ที่\s|เรื่อง|เรียน|อ้างถึง|สิ่งที่ส่งมาด้วย|\[(?:ชั้น|ด่วน|ลับ))/;
const CLOSING =
  /^(?:ขอแสดงความนับถือ|ขอแสดงความเคารพ|ขอแสดงความนับถืออย่างสูง|ด้วยความเคารพ|ขอแสดงความเคารพอย่างยิ่ง|\[รอยืนยัน: คำลงท้าย)/;
/** True when an earlier header paragraph is the เลขที่หนังสือ line (ที่ …). */
function afterNumber(blocks: DraftNode[], index: number) {
  return blocks.slice(0, index).some(node => node.type === 'paragraph' && /^ที่\s/.test(documentText(node).trim()));
}
export function documentLayoutRoles(document: DraftNode, id?: DocumentToolId): LayoutRole[] {
  const roles = baseLayoutRoles(document, id);
  if (id !== 'letter' && id !== 'memo') return roles;
  const blocks = document.content || [];
  const firstSignature = roles.indexOf('signature');
  if (firstSignature < 0) return roles;
  // The position under the printed name belongs to the signature block, even when it does not start with ตำแหน่ง.
  for (let index = firstSignature + 1; index < blocks.length; index++) {
    const text = documentText(blocks[index]).trim();
    const previous = documentText(blocks[index - 1]).trim();
    if (
      roles[index] !== 'signature' &&
      roles[index - 1] === 'signature' &&
      blocks[index].type === 'paragraph' &&
      /^\([^\n]{1,160}\)$/.test(previous) &&
      !/^\(ลงชื่อ\)/.test(previous) &&
      text.length <= 160 &&
      !/^(?:โทร|โทรสาร|ไปรษณีย์อิเล็กทรอนิกส์|E-?mail|อีเมล|สำเนาส่ง|ผู้ประสานงาน|ส่วนราชการ|ส่วนงาน)/i.test(text)
    )
      roles[index] = 'signature';
  }
  // ส่วนราชการเจ้าของเรื่อง, โทร, โทรสาร and สำเนาส่ง follow the signature at the left margin.
  if (id === 'letter') {
    const last = roles.lastIndexOf('signature');
    for (let index = last + 1; index < blocks.length; index++) if (blocks[index].type === 'paragraph') roles[index] = 'field';
  }
  return roles;
}
/** Space above the printed signer name, in points (about four blank lines of 16 pt). */
export const SIGNING_ROOM = 72;
/** Space above a "(ลงชื่อ) ....." line, where the signature sits on the dots and rises above them. */
export const DOTTED_SIGNING_ROOM = 66;
/** Paragraph spacing of the saraban print explanation for memo and letter, in points before the paragraph. */
export function sarabanSpacing(document: DraftNode, id?: DocumentToolId): number[] {
  const blocks = document.content || [];
  if (id !== 'memo' && id !== 'letter') return blocks.map(() => 0);
  const roles = documentLayoutRoles(document, id);
  const firstSignature = roles.indexOf('signature');
  const lastSignature = roles.lastIndexOf('signature');
  return blocks.map((node, index) => {
    const text = documentText(node).trim();
    const role = roles[index];
    if (role === 'signature') {
      if (index === firstSignature && CLOSING.test(text)) return 12;
      const previous = index > 0 ? documentText(blocks[index - 1]).trim() : '';
      // Room to sign above the printed name, or above a dotted signing line.
      // Set from the owner's Word checks (2026-11-17): 72 pt above the name in a letter, 66 pt above a (ลงชื่อ) line.
      if (index === firstSignature || (roles[index - 1] === 'signature' && CLOSING.test(previous)))
        return /^\(?ลงชื่อ\)?/.test(text) ? DOTTED_SIGNING_ROOM : SIGNING_ROOM;
      return 0;
    }
    if (id === 'letter' && role === 'field' && lastSignature >= 0 && index === lastSignature + 1) return 54;
    if (role === 'field' && /^(?:เรื่อง|เรียน|อ้างถึง|สิ่งที่ส่งมาด้วย)(?:\s|$)/.test(text)) return 6;
    if (role === 'body' && node.type !== 'heading' && index > 0) return 6;
    return 0;
  });
}
function baseLayoutRoles(document: DraftNode, id?: DocumentToolId): LayoutRole[] {
  const blocks = document.content || [];
  const section = blocks.findIndex((node, index) => index > 0 && node.type === 'heading');
  const recipient = blocks.findIndex(node => /^เรียน(?:\s|$)/.test(documentText(node)));
  const headerEnd = recipient >= 0 ? recipient : section >= 0 ? section : 12;
  return blocks.map((node, index) => {
    if (!id) return 'body';
    const text = documentText(node).trim();
    if (index === 0 && ['heading', 'title'].includes(node.type)) return 'title';
    if (node.type !== 'paragraph') return 'body';
    if (id === 'tor' && section > 0 && index < section && /^(?:ชื่อ(?:งาน|โครงการ)|(?:งาน)?(?:จัดซื้อ|ซื้อ|จ้าง|เช่า)|โครงการ)/.test(text))
      return 'subject';
    if (['tor', 'project'].includes(id) && section > 0 && index < section) return 'front';
    if (id === 'minutes' && index < (section >= 0 ? section : 12) && /^(?:ชื่อการประชุม|ครั้งที่|วัน เวลา สถานที่|เมื่อ\s|ณ\s)/.test(text))
      return 'front';
    if (id === 'memo' && index <= headerEnd && /^ที่\s/.test(text) && /^[^\r\n]*[ \t]+วันที่[ \t]/.test(text)) return 'memo-reference';
    if (id === 'letter' && index <= headerEnd) {
      if (/^(?:หน่วยงาน|\[รอยืนยัน: หน่วยงาน)/.test(text)) return 'sender';
      if (/^(?:วันที่|\[รอยืนยัน: (?:วันที่|วัน เดือน ปี))/.test(text) || LETTER_DATE.test(text)) return 'date';
      // The sender's name and address sit between เลขที่หนังสือ and the date, whatever the agency is called.
      if (afterNumber(blocks, index) && !LETTER_FIELD.test(text)) return 'sender';
    }
    if (
      ['tor', 'memo', 'letter', 'minutes'].includes(id) &&
      (/^(?:\(ลงชื่อ\)|ตำแหน่ง|ขอแสดงความนับถือ|ผู้จดรายงาน|ผู้ตรวจรายงาน|\[รอยืนยัน: (?:ผู้ลงนาม|ชื่อและตำแหน่ง|คำลงท้าย))/.test(text) ||
        /^\([^\n]{1,160}\)$/.test(text) ||
        /^(?:ผู้ดูแลโครงการ|ผู้จัดทำ|ผู้ตรวจทาน|ผู้กำหนดขอบเขตงาน|ผู้เสนอเรื่อง|หัวหน้าทีม|ผู้อำนวยการ)(?:\s|$)/.test(text))
    )
      return 'signature';
    if (
      /^(?:ส่วนราชการ|ส่วนงาน|ความเห็นผู้พิจารณา|ความเห็นผู้เสนอ|คำสั่ง\s*\/|ที่\s|วันที่|เรื่อง|เรียน|อ้างถึง|สิ่งที่ส่งมาด้วย|หน่วยงาน|ผู้รับผิดชอบ|ผู้มาประชุม|ผู้ไม่มาประชุม|ผู้เข้าร่วมประชุม|เริ่มประชุม|เลิกประชุม|ครั้งที่|วัน เวลา|มติ|สาระสำคัญ|ข้อเสนอที่ยังไม่ตกลง|การรับรองรายงาน|\[รอยืนยัน:)/.test(
        text,
      )
    )
      return 'field';
    return 'body';
  });
}

/** Standalone for the trusted local renderer. Canvas measures availability, not official-font conformance. */
export function probeDocumentFont(font: string): 'available' | 'missing' | 'unknown' {
  try {
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return 'unknown';
    for (const sample of ['กขฃคฅฆงจฉชซญฑฒณดตถทธนบปผฝพฟมยรลวศษสหฬอฮ012345', 'Wim0123456789'])
      for (const fallback of ['monospace', 'serif', 'sans-serif']) {
        context.font = `32px ${fallback}`;
        const baseline = context.measureText(sample).width;
        context.font = `32px "${font}",${fallback}`;
        if (Math.abs(context.measureText(sample).width - baseline) > 0.01) return 'available';
      }
    return 'missing';
  } catch {
    return 'unknown';
  }
}
