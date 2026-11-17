import { documentText, type DraftNode } from './draft.ts';
import { parseThaiDate } from './thai-date.ts';

/** Only current-task URLs enter a QR. Formatting never follows or fetches a URL. */
export const INVITATION_RSVP_STATUSES = ['pending', 'confirmed', 'delegate', 'declined'] as const;
export type InvitationRsvpStatus = (typeof INVITATION_RSVP_STATUSES)[number];
export const INVITATION_RSVP_LABELS: Readonly<Record<InvitationRsvpStatus, string>> = {
  pending: 'รอตอบรับ',
  confirmed: 'ตอบรับเข้าร่วม',
  delegate: 'มอบผู้แทน',
  declined: 'ขัดข้อง',
};
export type InvitationRecipient = {
  number: string;
  recipient: string;
  position: string;
  seats: number;
  status: InvitationRsvpStatus;
  confirmedSeats: number;
  attendees: string;
};
export type InvitationSummary = {
  letters: number;
  invitedSeats: number;
  pendingLetters: number;
  respondedLetters: number;
  declinedLetters: number;
  confirmedSeats: number;
};
export type InvitationPresentation = { rsvpUrl: string; venueUrl: string; recipients?: InvitationRecipient[] };
export const blankInvitationRecipient = (): InvitationRecipient => ({
  number: '',
  recipient: '',
  position: '',
  seats: 1,
  status: 'pending',
  confirmedSeats: 0,
  attendees: '',
});
function invitationFieldText(value: unknown, maxLength = 500): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new Error('INVALID_DOCUMENT_PRESENTATION');
  const text = value.trim();
  if (text.length > maxLength || /[\r\n\u0000-\u001f\u007f]/.test(text)) throw new Error('INVALID_DOCUMENT_PRESENTATION');
  return text;
}
function invitationSeatCount(value: unknown, min: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 500) throw new Error('INVALID_DOCUMENT_PRESENTATION');
  return value;
}
export function resolveInvitationRecipient(value: unknown): InvitationRecipient {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !['number', 'recipient', 'position', 'seats', 'status', 'confirmedSeats', 'attendees'].includes(key))
  )
    throw new Error('INVALID_DOCUMENT_PRESENTATION');
  const input = value as Partial<InvitationRecipient>;
  const status = input.status ?? 'pending';
  if (!INVITATION_RSVP_STATUSES.includes(status as InvitationRsvpStatus)) throw new Error('INVALID_DOCUMENT_PRESENTATION');
  const seats = invitationSeatCount(input.seats, 1, 1);
  const confirmedSeats = invitationSeatCount(input.confirmedSeats, 0, 0);
  return {
    number: invitationFieldText(input.number, 160),
    recipient: invitationFieldText(input.recipient),
    position: invitationFieldText(input.position),
    seats,
    status,
    confirmedSeats,
    attendees: invitationFieldText(input.attendees),
  };
}
export function invitationSummary(recipients: readonly InvitationRecipient[] = []): InvitationSummary {
  let invitedSeats = 0,
    pendingLetters = 0,
    respondedLetters = 0,
    declinedLetters = 0,
    confirmedSeats = 0;
  for (const item of recipients) {
    invitedSeats += item.seats;
    if (item.status === 'pending') pendingLetters++;
    else if (item.status === 'declined') declinedLetters++;
    else {
      respondedLetters++;
      confirmedSeats += item.confirmedSeats;
    }
  }
  return {
    letters: recipients.length,
    invitedSeats,
    pendingLetters,
    respondedLetters,
    declinedLetters,
    confirmedSeats,
  };
}
export function invitationUrl(value: unknown): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new Error('INVALID_INVITATION_URL');
  const text = value.trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text) || new TextEncoder().encode(text).length > 2048 || /[\s\u0000-\u001f\u007f]/.test(text))
    throw new Error('INVALID_INVITATION_URL');
  try {
    const url = new URL(text);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error();
  } catch {
    throw new Error('INVALID_INVITATION_URL');
  }
  return text;
}
export function resolveInvitation(value: unknown): InvitationPresentation {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !['rsvpUrl', 'venueUrl', 'recipients'].includes(key))
  )
    throw new Error('INVALID_DOCUMENT_PRESENTATION');
  const input = value as Partial<InvitationPresentation>;
  if (input.recipients !== undefined && (!Array.isArray(input.recipients) || input.recipients.length > 200))
    throw new Error('INVALID_DOCUMENT_PRESENTATION');
  const recipients = input.recipients?.map(resolveInvitationRecipient);
  return {
    rsvpUrl: invitationUrl(input.rsvpUrl),
    venueUrl: invitationUrl(input.venueUrl),
    ...(recipients?.length ? { recipients } : {}),
  };
}

/** Physical measurements shared by both exporters; the original PDFs remain private. */
export const INVITATION_LAYOUT = {
  frontHangCm: 0.9,
  dateBeforeCm: 0.4,
  dateAfterCm: 0.2,
  points: 16,
  line: 1.13,
  indent: 2.5,
  after: 8,
  margins: { top: 1.5, bottom: 1.5, left: 3, right: 2 },
  headerColumnsCm: [6, 3, 7],
  qrCm: 2.5,
  signatureGapCm: 1.2,
} as const;

/** Apply one recipient row's document number, addressee name and position to a clone of the letter. */
export function invitationForRecipient(document: DraftNode, recipient: InvitationRecipient): DraftNode {
  const blocks = (document.content || []).map(node => structuredClone(node));
  const num = recipient.number.trim();
  if (num) {
    const text = /^ที่(?:\s|$)/.test(num) ? num : `ที่ ${num}`;
    const node: DraftNode = { type: 'paragraph', content: [{ type: 'text', text }] };
    const subject = blocks.findIndex(n => /^เรื่อง(?:\s|$)/.test(documentText(n).trim()));
    const limit = subject >= 0 ? subject : blocks.length;
    const existing = blocks.findIndex((n, i) => i < limit && /^ที่\s/.test(documentText(n).trim()));
    if (existing >= 0) blocks[existing] = node;
    else blocks.unshift(node);
  }
  const name = recipient.recipient.trim().replace(/^เรียน\s+/, '');
  const position = recipient.position.trim();
  if (name || position) {
    const content: DraftNode[] = [{ type: 'text', text: `เรียน ${name || position}` }];
    if (name && position) content.push({ type: 'hardBreak' }, { type: 'text', text: position });
    const node: DraftNode = { type: 'paragraph', content };
    const existing = blocks.findIndex(n => /^เรียน(?:\s|$)/.test(documentText(n).trim()));
    if (existing >= 0) blocks[existing] = node;
    else {
      const subject = blocks.findIndex(n => /^เรื่อง(?:\s|$)/.test(documentText(n).trim()));
      blocks.splice(subject >= 0 ? subject + 1 : 0, 0, node);
    }
  }
  return { ...document, content: blocks };
}

/** Classify the latest editable blocks, never cached form prose. Every block is retained exactly once. */
export function invitationParts(document: DraftNode) {
  const blocks = document.content || [];
  const subject = blocks.findIndex(n => /^เรื่อง(?:\s|$)/.test(documentText(n).trim()));
  const front = subject >= 0 ? blocks.slice(0, subject) : [];
  const number = front.filter(n => /^ที่\s/.test(documentText(n).trim()));
  const date = front.filter(n =>
    /^(?:วันที่\s|[\d๐-๙]{1,2}\s+(?:มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม))/.test(
      documentText(n).trim(),
    ),
  );
  const sender = front.filter(n => !number.includes(n) && !date.includes(n));
  const rest = subject >= 0 ? blocks.slice(subject) : blocks;
  const signatureStart = rest.findIndex(n => /^ขอแสดงความนับถือ/.test(documentText(n).trim()));
  const contactStart =
    signatureStart >= 0
      ? rest.findIndex(
          (n, i) =>
            i > signatureStart &&
            /^(?:ผู้ประสานงาน|ส่วนงานเจ้าของเรื่อง|ติดต่อ|โทร\.|โทรศัพท์|E-mail\s*:|อีเมล)/i.test(documentText(n).trim()),
        )
      : -1;
  return {
    number,
    sender,
    date,
    body: signatureStart < 0 ? rest : rest.slice(0, signatureStart),
    signature: signatureStart < 0 ? [] : rest.slice(signatureStart, contactStart < 0 ? undefined : contactStart),
    contact: contactStart < 0 ? [] : rest.slice(contactStart),
  };
}

const MISSING_VALUE = /\[รอยืนยัน:[ \t]*([^\]\n]+)\]/g;
const PROPOSED_WORDING = /\[AI_PROPOSED\][ \t]*/g;
const EMPTY_FIELD_LINE =
  /^(?:(?:ที่|วันที่|เรียน|อ้างถึง|สิ่งที่ส่งมาด้วย|ผู้ประสานงาน|โทรศัพท์|โทร\.|ไปรษณีย์อิเล็กทรอนิกส์|อีเมล)\s*:?\s*)?(?:\(\s*\))?\s*\\?$/;

/** A new model draft may still use the general letter's status markers. Keep any inline gap editable. */
export function invitationDraft(draft: string): string {
  const wording = draft.replace(PROPOSED_WORDING, '');
  if (!wording.includes('[รอยืนยัน:')) return wording.trim();
  return wording
    .split('\n')
    .map(line => {
      const blank = line.replace(MISSING_VALUE, '');
      if (blank === line) return line;
      return EMPTY_FIELD_LINE.test(blank.trim()) ? '' : line.replace(MISSING_VALUE, '________');
    })
    .join('\n')
    .replace(/\\(?=\n(?:\n|$)|$)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Local consistency hints are evidence for review, never edits or a certification of the source. */
export function invitationReview(draft: string, invitation?: InvitationPresentation): string[] {
  const notes: string[] = [];
  const pending = [...new Set([...draft.matchAll(MISSING_VALUE)].map(match => match[1].trim()).filter(Boolean))];
  if (pending.length) notes.push('ข้อมูลที่ยังต้องยืนยัน: ' + pending.join(', '));
  if (draft.match(PROPOSED_WORDING)) notes.push('ถ้อยคำที่ AI เสนอเป็นร่างสำหรับเจ้าของเรื่องพิจารณา');
  if (invitation?.recipients?.length) {
    const summary = invitationSummary(invitation.recipients);
    notes.push(
      `ทะเบียนหนังสือเชิญ: หนังสือ ${summary.letters} ฉบับ · ที่นั่งเชิญรวม ${summary.invitedSeats} ที่นั่ง · ตอบรับแล้ว ${summary.respondedLetters} ฉบับ (ยืนยันเข้าร่วม ${summary.confirmedSeats} คน) · รอตอบรับ ${summary.pendingLetters} ฉบับ` +
        (summary.declinedLetters ? ` · ขัดข้อง ${summary.declinedLetters} ฉบับ` : ''),
    );
    if (invitation.recipients.some(r => !r.recipient.trim())) notes.push('มีรายการในทะเบียนหนังสือเชิญที่ยังไม่ได้ระบุชื่อผู้รับ');
    if (invitation.recipients.some(r => (r.status === 'confirmed' || r.status === 'delegate') && r.confirmedSeats === 0))
      notes.push('มีหน่วยงานที่ตอบรับเข้าร่วมแต่ยังระบุจำนวนผู้ยืนยันเข้าร่วมเป็น 0 คน');
    const overSeats = invitation.recipients.flatMap((r, index) => (r.confirmedSeats > r.seats ? [index + 1] : []));
    if (overSeats.length) notes.push('จำนวนผู้ยืนยันเข้าร่วมเกินจำนวนที่นั่งที่เชิญ ในหนังสือฉบับที่ ' + overSeats.join(', '));
  }
  const months = 'มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม';
  const days = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  const matches = [
    ...draft.matchAll(
      new RegExp(`(?:วัน(${days.join('|')})(?:ที่)?\\s*)?([\\d๐-๙]{1,2}\\s+(?:${months})\\s+(?:พ\\.?ศ\\.?\\s*)?[\\d๐-๙]{4})`, 'g'),
    ),
  ];
  let event: Date | null = null,
    deadline: Date | null = null;
  for (const match of matches) {
    const date = parseThaiDate(match[2]);
    if (!date) {
      notes.push('ตรวจวันที่ที่อ่านไม่ได้: ' + match[0]);
      continue;
    }
    if (match[1] && days[date.getUTCDay()] !== match[1]) notes.push('วันในสัปดาห์ไม่ตรงกับวันที่: ' + match[0]);
    const before = draft.slice(Math.max(0, match.index! - 100), match.index);
    if (/ตอบรับ[^\n]*?(?:ภายใน|ถึง|ปิด)|ปิดตอบรับ\s*(?:วันที่)?\s*$/.test(before)) deadline = date;
    else if (/(?:ในวัน(?:ที่)?|จัดงาน|จัดกิจกรรม|กำหนดจัด)[\s\S]{0,80}$/.test(before)) event = date;
  }
  if (event && deadline && deadline > event) notes.push('วันปิดตอบรับอยู่หลังวันจัดงาน ต้องยืนยันกำหนดการกับเจ้าของเรื่อง');
  const attachment = /^สิ่งที่ส่งมาด้วย\s+(.+)$/m.exec(draft);
  if (attachment) notes.push('ตรวจไฟล์สิ่งที่ส่งมาด้วยให้ครบตามรายการก่อนออกหนังสือ: ' + attachment[1]);
  return notes;
}
