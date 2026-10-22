import { parseYamlInlineList, stripYamlScalar } from './simple-yaml.js';
export function createAuthorityEngine(organizationYaml = '') {

function parseAuthorityRegistry(text = '') {
  const authorities = [];
  let current = null;

  for (const line of String(text).split(/\r?\n/)) {
    const entry = line.match(/^ {2}([a-z0-9-]+):\s*$/);
    if (entry) {
      current = {
        id: entry[1],
        name: '',
        authorizedRole: '',
        alternateRole: '',
        humanInTheLoop: '',
        description: '',
        triggers: [],
        actions: [],
        objects: [],
        qualifiers: [],
      };
      authorities.push(current);
      continue;
    }
    if (!current) continue;

    const scalar = line.match(/^ {4}(name|authorizedRole|alternateRole|humanInTheLoop|description):\s*(.+)$/);
    if (scalar) {
      current[scalar[1]] = stripYamlScalar(scalar[2]);
      continue;
    }

    const list = line.match(/^ {4}(triggers|actions|objects|qualifiers):\s*\[(.*?)\]\s*$/);
    if (list) current[list[1]] = parseYamlInlineList(list[2]);
  }

  return authorities;
}


function normalize(value = '') {
  return String(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Only remove the approval word inside an explicit request to draft a request
// document. Independent approval/signing clauses remain visible to the gates.
/**
 * A clause that declines an action is not a request to perform it: "ยังไม่ต้องกด
 * Submit" must not trip the submission gate. Drop the negated clause up to the
 * next clause boundary so its verb never reaches a trigger match.
 */
//
// The clause ends at punctuation, at a space (Thai separates clauses with
// spaces, not commas), or at a conjunction that starts a new request. Phrases
// that look negative but ask for the act ("อย่าลืมเซ็น" = don't forget to sign,
// "ไม่ต้องรอ ผอ." = don't wait for the director) are not declinations.
const NEGATION = '(?:ยังไม่ต้อง|ไม่ต้อง(?!รอ)|ยังไม่|อย่าเพิ่ง|อย่า(?!ลืม)|ห้าม|ไม่ควร)';
const DECLINED_ACTION = new RegExp(
  `(?:แต่)?[ \\t]*(?:${NEGATION}[^,;\\n ]*(?: (?:กด|ส่ง|submit|ทำ|ลง|เซ็น)[^,;\\n ]*)?`
  + `|(?:do(?:es)? not|don['’]t|no need to|without)[^,;\\n]*?(?=,|;|\\n|$| but | and | just ))`,
  'gi',
);

/**
 * "ลงนาม" as a noun or as the document's destination is not a request to sign:
 * a letter names its signer, leaves a signature line, and is proposed to an
 * executive for signing. Only the act itself ("ช่วยลงนาม", "ลงนามแทน") belongs
 * to the signing gate, so these phrasings are neutralised before matching.
 */
// Signer titles in the forms staff actually type: full, abbreviated, with or
// without the dot or space ("รอง ผอ.", "รองผอ", "ผช.ผอ."), and in English.
// Longer forms come first so the alternation does not stop at a prefix.
const SIGNER_TITLES = [
  'ผู้ช่วยผู้อำนวยการ', 'รองผู้อำนวยการ', 'ผู้อำนวยการ',
  'ผช\\.?\\s?ผอ\\.?', 'รอง\\s?ผอ\\.?', 'ผอ\\.?',
  'รองอธิการบดี', 'อธิการบดี', 'รองคณบดี', 'คณบดี',
  'ผู้จัดการ', 'ผจก\\.?', 'หัวหน้าทีม', 'หัวหน้างาน', 'หัวหน้า', 'หน\\.\\s?ทีม', 'หน\\.',
  'ประธาน(?:กรรมการ)?', 'ผู้บริหาร', 'ผู้มีอำนาจ(?:ลงนาม)?', 'ท่าน',
  'deputy director', 'director', 'manager', 'head',
];
// Executives by name, from the public roster in manifest/organization.yaml,
// so a draft may say "เสนอ รศ.ดร.ปิติวัฒน์ ลงนาม" or "ให้คุณเมลินลงนาม". The
// roster is the single source: when it changes, this follows.
const HONORIFICS = '(?:(?:รศ|ผศ|ศ|ดร|อ)\\.?\\s?|อาจารย์\\s?|คุณ\\s?|นางสาว|นาง|นาย|พี่\\s?|ท่าน\\s?)*';

function loadExecutiveNamePatterns() {
  try {
    const text = organizationYaml;
    const section = text.split(/^executiveOversight:/m)[1] || '';
    return [...section.matchAll(/^\s+- name:\s*"([^"]+)"/gm)].map(([, full]) => {
      const bare = full.replace(/^(?:\s*(?:รศ\.|ผศ\.|ศ\.|ดร\.|อ\.|อาจารย์|นางสาว|นาง|นาย))+\s*/, '').trim();
      const [first, last] = bare.split(/\s+/);
      const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return first ? `${HONORIFICS}${escape(first)}(?:\\s?${escape(last || '')})?` : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// Words a title can carry before "ลงนาม" ("ผู้อำนวยการอุทยานวิทยาศาสตร์ฯ",
// "รอง ผอ. ที่กำกับ HD"),
// excluding anything that turns the sentence into a request to act:
// "เสนอผู้อำนวยการแล้วช่วยลงนามแทน" must still reach the signing gate.
const TITLE_SUFFIX = '(?:(?!แล้ว|ช่วย|และ|แทน|ให้|เลย|ลงนาม)[^,;\\n]){0,40}?';
const SIGNING_ROLE = `(?:${[...loadExecutiveNamePatterns(), ...SIGNER_TITLES].join('|')})${TITLE_SUFFIX}`;
const SIGNING_MENTION = new RegExp([
  '(?:ผู้|ช่อง|ส่วน|ตำแหน่ง|บรรทัด)(?:ลงนาม|เซ็น|ลายเซ็น|ลายมือชื่อ)',
  '(?:เสนอ|เพื่อเสนอ|เพื่อ|รอ(?:การ)?|ก่อน(?:เสนอ)?|หลัง(?:การ)?)\\s*(?:' + SIGNING_ROLE + ')?\\s*(?:พิจารณา)?\\s*ลงนาม',
  'ให้\\s*' + SIGNING_ROLE + '\\s*(?:พิจารณา)?\\s*ลงนาม',
  'ลงนามโดย',
].join('|'), 'gi');

// "ไม่ต้องรอ ผอ. ลงนาม…" tells the assistant to skip the signer, not to wait for
// one, so it must not be read as a draft awaiting signature.
const SKIP_SIGNER = new RegExp(`(?:ไม่ต้อง|ไม่จำเป็นต้อง)\\s*รอ(?:ให้)?\\s*(?:${SIGNING_ROLE})?`, 'gi');

/**
 * Phrases that describe a document being drafted rather than an act being
 * requested: a memo that asks for approval, a letter that names its signer.
 * Intent detection uses this alone; the authority gates also drop declined
 * clauses, which would strip content ("ไม่ตรงกัน") from intent detection.
 */
function neutralizeDraftingPhrases(query = '') {
  return String(query)
    .replace(SKIP_SIGNER, ' ')
    // Missing approval evidence or an unknown approver describes the source
    // gap of a draft, not an order to approve it. Keep independent approval
    // and enactment clauses visible, including later acts in the same request.
    .replace(/((?:ยัง)?ไม่มี\s*(?:SOP|WI)\s*(?:ฉบับ\s*)?ที่\s*(?:ได้รับ|ผ่านการ)?\s*)อนุมัติ/gi, '$1ผ่านการพิจารณา')
    .replace(/((?:ยัง)?ไม่(?:ทราบ|รู้)\s*ผู้)อนุมัติ/gi, '$1มีอำนาจ')
    .replace(/((?:ร่าง|จัดทำ|เขียน)\s*(?:บันทึก(?:ข้อความ)?|หนังสือ|เอกสาร)\s*(?:เพื่อ)?\s*(?:ขอ|เสนอขอ))\s*อนุมัติ/g, '$1เสนอพิจารณา')
    .replace(/((?:สรุป|อธิบาย)\s*ขั้นตอน)\s*อนุมัติ(?=งบ|วงเงิน)/g, '$1การพิจารณา')
    .replace(/((?:ช่วย)?เลือก)\s*(?=เกณฑ์ประเมินผู้ขาย(?:สำหรับ|เพื่อ))/g, 'จัดทำ')
    .replace(SIGNING_MENTION, 'ผู้มีอำนาจ');
}

function authorityIntentText(query = '') {
  return neutralizeDraftingPhrases(query).replace(DECLINED_ACTION, ' ');
}

const LATIN = /^[\x20-\x7e]+$/;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Latin terms must match whole words so "sign" does not fire inside "design"
// and "rate" not inside "generate". Thai has no word spaces, so Thai terms
// match as substrings and are chosen long enough to be unambiguous.
function findTerm(text, term) {
  const needle = normalize(term);
  if (!needle) return -1;
  if (!LATIN.test(needle)) return text.indexOf(needle);
  const match = new RegExp(`(?<![a-z0-9])${escapeRegExp(needle)}(?![a-z0-9])`).exec(text);
  return match ? match.index : -1;
}

// Every concept group must be present, and close enough together to belong to
// the same request: "เลือก" at the start and "ผู้ขาย" three sentences later is
// a different conversation.
const CONCEPT_WINDOW = 60;

function matchConcepts(text, authority) {
  const groups = [authority.actions, authority.objects, authority.qualifiers]
    .filter((group) => Array.isArray(group) && group.length);
  if (groups.length < 2) return null;
  const hits = groups.map((group) => group.flatMap((term) => {
    const needle = normalize(term);
    if (!needle) return [];
    const positions = [];
    if (LATIN.test(needle)) {
      const pattern = new RegExp(`(?<![a-z0-9])${escapeRegExp(needle)}(?![a-z0-9])`, 'g');
      for (const match of text.matchAll(pattern)) positions.push(match.index);
    } else {
      let index = text.indexOf(needle);
      while (index >= 0) {
        // "ร่างบันทึก" contains the letters งบ but is not a budget noun.
        // An unrelated approval later in the request must not become an AFP
        // allocation merely because its draft was called a บันทึก.
        if (!(needle === 'งบ' && text.startsWith('ร่างบันทึก', index - 3))) {
          positions.push(index);
        }
        index = text.indexOf(needle, index + 1);
      }
    }
    return positions.map((index) => ({ term, index }));
  }));
  if (hits.some((group) => !group.length)) return null;
  let best = null;
  function visit(groupIndex, selected, start, end) {
    if (groupIndex === hits.length) {
      const score = selected.reduce((sum, hit) => sum + hit.term.length, 0);
      if (!best || score > best.score) best = { score, selected };
      return;
    }
    for (const hit of hits[groupIndex]) {
      const low = Math.min(start, hit.index);
      const high = Math.max(end, hit.index);
      if (high - low <= CONCEPT_WINDOW) visit(groupIndex + 1, [...selected, hit], low, high);
    }
  }
  visit(0, [], Infinity, -Infinity);
  return best ? best.selected.map((hit) => hit.term).join(' + ') : null;
}

const GATED = new Set(['mandatory', 'confirmation']);

function evaluateAuthorityPreflight(query = '', authorities = []) {
  const intent = normalize(authorityIntentText(query));
  const matches = [];

  for (const authority of authorities || []) {
    const gate = String(authority.humanInTheLoop).toLowerCase();
    if (!GATED.has(gate)) continue;
    for (const trigger of authority.triggers || []) {
      if (findTerm(intent, trigger) < 0) continue;
      matches.push({ authority, gate, trigger, specificity: 100 + normalize(trigger).length });
    }
    const concept = matchConcepts(intent, authority);
    if (concept) matches.push({ authority, gate, trigger: concept, specificity: concept.length });
  }

  if (!matches.length) {
    return { status: 'ALLOW', inScope: true, source: 'global-authority-preflight' };
  }

  // A human-only act outranks a confirmation; within a gate, a named trigger
  // outranks a concept match, and a longer phrase outranks a shorter one.
  matches.sort((a, b) => (a.gate === b.gate ? 0 : a.gate === 'mandatory' ? -1 : 1)
    || b.specificity - a.specificity
    || a.authority.id.localeCompare(b.authority.id));
  const winner = matches[0];
  const confirm = winner.gate === 'confirmation';

  return {
    status: confirm ? 'ESCALATE' : 'BLOCK',
    inScope: false,
    ruleKey: winner.authority.id,
    targetRole: winner.authority.authorizedRole || 'authorized-human',
    alternateRole: winner.authority.alternateRole || '',
    authority: winner.authority.id,
    matchedTrigger: winner.trigger,
    reason: confirm
      ? `Human Confirmation Gate: ${winner.authority.name}. ${winner.authority.description}`
      : `คำขอนี้แตะอำนาจมนุษย์ที่บังคับ Human-in-the-loop: ${winner.authority.name}. ${winner.authority.description}`,
    source: 'global-authority-preflight',
  };
}

return { parseAuthorityRegistry, evaluateAuthorityPreflight, neutralizeDraftingPhrases, authorityIntentText };
}
