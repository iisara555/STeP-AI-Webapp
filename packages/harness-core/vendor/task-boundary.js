/**
 * Current-turn task boundary policy.
 *
 * The latest user message is authoritative. Earlier chat/source/draft context is
 * available only when the current turn explicitly refers to it. Editing an
 * existing draft is stricter still: an ordinary new question must never be
 * converted into a revision merely because a draft already exists.
 */

const EXPLICIT_HISTORY_PATTERNS = [
  /เมื่อกี้|เมื่อครู่|ก่อนหน้านี้|ข้อความก่อน|คำตอบก่อน|ข้างบน|ด้านบน/i,
  /เรื่องเดิม|งานเดิม|อันเดิม|ไฟล์เดิม|เอกสารเดิม|แบบเดิม/i,
  /ต่อจาก|ต่อเรื่อง|ต่อยอดจาก|กลับมาที่|ย้อนกลับไป/i,
  /จากที่(?:เรา)?คุย|จากที่พูด|ตามที่(?:เรา)?คุย|ตามที่บอก|ที่ถามไป|ที่ส่งไป/i,
];

// References such as "ใบเสร็จนี้" are explicit context links even without words
// such as "เมื่อกี้". This is important for persistent reviewed sources.
const SOURCE_REFERENCE_PATTERN =
  /(?:ใบเสร็จ|เอกสาร|ไฟล์|ข้อมูล|ร่าง|ข้อความ|ตาราง|รูป|ภาพ|รายการ|งาน)(?:นี้|นั้น|เดิม|ข้างต้น|ด้านบน)/i;

const LEADING_FOLLOWUP_PATTERN =
  /^\s*(?:แล้ว(?:ถ้า|กรณี|อัน|เรื่อง|แบบ|ต้อง|ทำ|ของ|จะ|ยัง|ควร|ได้|ไหม|หรือ)?)(?:\s|$)/i;

// "โอเค", "ได้เลย", "ok" and similar openers do not change what the rest of the message asks.
const ACKNOWLEDGEMENT =
  '(?:(?:โอเค|ok(?:ay)?|ได้(?:เลย)?|ดี(?:มาก)?|เยี่ยม|ขอบคุณ(?:มาก)?|thanks?)(?:\\s*(?:ครับ|ค่ะ|คะ|นะ|จ้า))?[\\s,.!]*)?';

// Only explicit edit language makes an existing draft a revision. Without this,
// a completely different task typed in the same Workspace must start fresh.
const REVISION_PATTERN = new RegExp(
  `^\\s*${ACKNOWLEDGEMENT}(?:ช่วย\\s*)?(?:ขอ\\s*)?(?:(?:ปรับ|แก้(?:ไข)?|เพิ่ม|ลด|ตัด|เปลี่ยน|ย่อ|ขยาย|เรียบเรียง|จัดรูปแบบ|เขียนใหม่|เติม|ลบ)|(?:rewrite|revise|edit)\\b)`,
  'i',
);

const RESUME_PATTERN = new RegExp(
  `^\\s*${ACKNOWLEDGEMENT}(?:(?:ช่วย\\s*)?(?:ทำ|เขียน)?ต่อ(?:เลย|ไป|จากเดิม|ให้(?:หน่อย|ด้วย|เสร็จ|จบ)?)?|เหมือนเดิม|เอาแบบเดิม|continue)(?:\\s*(?:ครับ|ค่ะ|คะ|นะ|หน่อย|จ้า))*\\s*$`,
  'i',
);

// Short follow-ups that people type to change the work just produced, without an
// edit verb at the start ("ขอแบบสั้นกว่านี้", "ทำเป็นภาษาอังกฤษด้วย"). They are only
// inferred: a host must still check that the message does not route to a new task.
const INFERRED_EDIT_PATTERN = new RegExp(
  [
    'กว่านี้|กว่าเดิม',
    '(?:สั้น|ยาว|กระชับ|ละเอียด|ทางการ|สุภาพ|ง่าย|ชัด(?:เจน)?|เป็นกันเอง)(?:ขึ้น|ลง)',
    '(?:ทำ|เปลี่ยน|แปล|เขียน|จัด|แสดง)(?:ให้)?(?:ออกมา)?เป็น\\s*(?:ภาษา|ตาราง|ข้อ|หัวข้อ|bullet|ย่อหน้า|อังกฤษ|ไทย|english|thai)',
    'เป็นภาษา\\s*(?:อังกฤษ|ไทย|จีน|ญี่ปุ่น|ลาว|พม่า)',
    '^\\s*(?:ช่วย\\s*)?แปล',
    '\\b(?:in|to|into)\\s+(?:english|thai)\\b',
    'ให้เหลือ',
    'อีก(?:แบบ|เวอร์ชัน|เวอร์ชั่น|รอบ|ครั้ง)',
    'ขอแบบ',
  ].join('|'),
  'i',
);

// "ทำต่อ", "เขียนต่อให้" inside a longer sentence: continue the current work.
const INFERRED_RESUME_PATTERN = /(?:ทำ|เขียน|ร่าง)ต่อ|ต่อให้(?:หน่อย|ด้วย|เสร็จ|จบ)|ต่อจากนี้/i;

// Pointers into the draft ("หัวข้อ 2", "ย่อหน้าแรก") link the question to it without asking for an edit.
const DRAFT_REFERENCE_PATTERN = /(?:หัวข้อ|ข้อ|ย่อหน้า|บรรทัด|ส่วน)(?:ที่)?\s*(?:\d+|แรก|สุดท้าย|ล่าสุด)/i;

// Questions about a file sent earlier ("แนบไฟล์ไปอ่านยัง", "ไฟล์ที่แนบ") refer to the conversation's files.
const ATTACHMENT_REFERENCE_PATTERN =
  /(?:แนบ|ส่ง|อัปโหลด|อัพโหลด)\s*(?:ไฟล์|เอกสาร)?\s*(?:ไป|มา|ให้|แล้ว)|(?:ไฟล์|เอกสาร)\s*ที่\s*(?:แนบ|ส่ง)|(?:อ่าน|เห็น|ได้รับ)\s*(?:ไฟล์|เอกสาร)?\s*(?:หรือ|แล้วหรือ)?\s*ยัง/i;

// A short pointer ("อันนี้", "นี่ไง", "ตามไฟล์นี้"), typically sent with a file for the request before it.
const DEICTIC_PATTERN =
  /^\s*(?:(?:ก็|เอา)\s*)?(?:อัน|ไฟล์|เอกสาร|ตัว|แบบ)?\s*(?:นี้|นี่|นั่น|นั้น)(?:\s*(?:ไง|เลย|แหละ|ครับ|ค่ะ|คะ|นะ|จ้า|ๆ))*\s*$|^\s*ตาม(?:นี้|ไฟล์(?:นี้)?|เอกสาร(?:นี้)?|ที่แนบ)(?:\s*(?:ครับ|ค่ะ|คะ|นะ|เลย))*\s*$/i;

// Inferred follow-ups are short. A longer message carries its own task.
const INFERRED_MAX_LENGTH = 80;

/**
 * Decide whether the host may carry earlier context into the current task.
 *
 * history="ignore": do not send earlier turns, active source, draft or route as
 * task context.
 *
 * history="relevant-only": the host may carry only the task-local context the
 * user explicitly referred to.
 *
 * revision=true: the current turn asks to edit the existing draft.
 * resume=true: the current turn asks to continue the existing work.
 * inferred=true: revision/resume came from a short follow-up without an explicit
 * edit or continue opener. Hosts must confirm it does not route to a different
 * task before treating it as a revision.
 * deictic=true: the whole message only points at something ("อันนี้"); it has no
 * task of its own and continues the earlier request, usually with a new file.
 */
export function classifyContextPolicy(currentQuery = '') {
  const text = String(currentQuery || '').trim();
  const explicitRevision = Boolean(text && REVISION_PATTERN.test(text));
  const explicitResume = Boolean(text && RESUME_PATTERN.test(text));
  const short = text.length > 0 && text.length <= INFERRED_MAX_LENGTH;
  const deictic = Boolean(text && DEICTIC_PATTERN.test(text));
  const inferredRevision = !explicitRevision && !explicitResume && short && INFERRED_EDIT_PATTERN.test(text);
  const inferredResume = !explicitRevision && !explicitResume && !inferredRevision && short && INFERRED_RESUME_PATTERN.test(text);
  const revision = explicitRevision || inferredRevision;
  const resume = explicitResume || inferredResume;
  const carryover = Boolean(
    text &&
      (revision ||
        resume ||
        EXPLICIT_HISTORY_PATTERNS.some(pattern => pattern.test(text)) ||
        SOURCE_REFERENCE_PATTERN.test(text) ||
        LEADING_FOLLOWUP_PATTERN.test(text) ||
        ATTACHMENT_REFERENCE_PATTERN.test(text) ||
        deictic ||
        (short && DRAFT_REFERENCE_PATTERN.test(text))),
  );

  return {
    currentTurn: 'authoritative',
    history: carryover ? 'relevant-only' : 'ignore',
    carryover,
    revision,
    resume,
    ...(inferredRevision || inferredResume ? { inferred: true } : {}),
    ...(deictic ? { deictic: true } : {}),
  };
}
