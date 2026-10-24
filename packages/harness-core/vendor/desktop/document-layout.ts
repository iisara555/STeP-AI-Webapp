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

export type LayoutRole = 'title' | 'front' | 'sender' | 'date' | 'memo-reference' | 'signature' | 'field' | 'body';
export function documentLayoutRoles(document: DraftNode, id?: DocumentToolId): LayoutRole[] {
  const blocks = document.content || [];
  const section = blocks.findIndex((node, index) => index > 0 && node.type === 'heading');
  const recipient = blocks.findIndex(node => /^เรียน(?:\s|$)/.test(documentText(node)));
  const headerEnd = recipient >= 0 ? recipient : section >= 0 ? section : 12;
  return blocks.map((node, index) => {
    if (!id) return 'body';
    const text = documentText(node).trim();
    if (index === 0 && ['heading', 'title'].includes(node.type)) return 'title';
    if (node.type !== 'paragraph') return 'body';
    if (['tor', 'project'].includes(id) && section > 0 && index < section) return 'front';
    if (id === 'minutes' && index < (section >= 0 ? section : 12) && /^(?:ชื่อการประชุม|ครั้งที่|วัน เวลา สถานที่)/.test(text))
      return 'front';
    if (id === 'memo' && index <= headerEnd && /^ที่\s/.test(text) && /^[^\r\n]*[ \t]+วันที่[ \t]/.test(text)) return 'memo-reference';
    if (id === 'letter' && index <= headerEnd) {
      if (/^(?:หน่วยงาน|\[รอยืนยัน: หน่วยงาน)/.test(text)) return 'sender';
      if (/^(?:วันที่|\[รอยืนยัน: วันที่)/.test(text)) return 'date';
    }
    if (
      ['memo', 'letter', 'minutes'].includes(id) &&
      (/^(?:\(ลงชื่อ\)|ตำแหน่ง|ขอแสดงความนับถือ|ผู้จดรายงาน|ผู้ตรวจรายงาน|\[รอยืนยัน: (?:ผู้ลงนาม|ชื่อและตำแหน่ง|คำลงท้าย))/.test(text) ||
        /^\([^\n]{1,160}\)$/.test(text) ||
        /^(?:ผู้ดูแลโครงการ|ผู้จัดทำ|ผู้เสนอเรื่อง|หัวหน้าทีม|ผู้อำนวยการ)(?:\s|$)/.test(text))
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
