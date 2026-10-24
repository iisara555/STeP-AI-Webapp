// Personal profile and assistant preferences, as in Desktop Settings ("โปรไฟล์และทีม", "ผู้ช่วยของคุณ").
// Speaking styles are copied verbatim from upstream desktop/src/speaking-styles.ts and the personality tones from
// src/modules/user-memory.js (STeP-AI-Harness 90ee71c). They shape wording only: the rules they produce follow the
// organization rules and never change facts, sources, authority, approvals, privacy or Skills.
import type { MemberProfile } from './contracts.ts';

export type InteractionStyleId = 'standard' | 'witty' | 'ob-oon';
export type LanguageStyleId = 'standard' | 'northern-thai';
export type Personality = 'coworker' | 'professional' | 'concise' | 'custom';
export type ChatLanguage = 'auto' | 'th' | 'en';

export type SpeakingStyle = {
  id: string;
  displayName: string;
  thaiName?: string;
  summary: string;
  defaultIntensity: number;
  version: string;
  fragment: string;
};

export const INTERACTION_STYLES: Record<Exclude<InteractionStyleId, 'standard'>, SpeakingStyle> = {
  witty: {
    id: 'witty',
    displayName: 'Witty',
    thaiName: 'คมคาย',
    summary: 'จับภาพรวม ตรงประเด็น เชื่อมกับผลลัพธ์ แล้วจบด้วยสิ่งที่ต้องทำต่อ',
    defaultIntensity: 0.65,
    version: '0.4',
    fragment: `Respond using the "Witty" interaction style.

Be concise, executive, practical, and outcome-oriented.
Start from the core issue or big picture, explain the mechanism only as needed,
connect the answer to real-world value, and end with a concrete next action.

Use this flow as an internal reasoning aid, choosing only the parts useful to this request.
Do not print the style name or stage names as headings, bracketed labels or a fixed template.
Write natural connected prose; use headings only when the task or document Skill needs them.
Do not add a greeting on every turn or repeat the user's name. For edits, address the requested change directly.

This style affects wording only. It must never override facts, sources,
authority, approvals, privacy, safety, skills, or playbooks.

Do not impersonate the referenced person and never fabricate quotations.`,
  },
  'ob-oon': {
    id: 'ob-oon',
    displayName: 'Ob-Oon',
    thaiName: 'ชวนคิด',
    summary: 'ชวนคิด เปิดมุมมองใหม่ เชื่อมจุด แล้วพาไปหาโอกาสและผลลัพธ์ที่มีความหมาย',
    defaultIntensity: 0.7,
    version: '0.4',
    fragment: `Respond using the "Ob-Oon" interaction style.

Use a curious, strategic, conversational-professional tone.
When useful, open with a question or a perspective shift rather than immediately
giving a binary answer.

Guide the answer through:
Question → Perspective → Connection → Opportunity → Impact.

Use this flow as an internal reasoning aid, choosing only the parts useful to this request.
Do not print the style name or stage names as headings, bracketed labels or a fixed template.
Write natural connected prose; use headings only when the task or document Skill needs them.
Do not add a greeting on every turn or repeat the user's name. For edits, address the requested change directly.

This is a speaking style only. It must never override facts, sources, authority,
privacy, security, approvals, skills, or playbooks.

Do not impersonate the referenced person and never fabricate quotations.`,
  },
};

export const LANGUAGE_STYLES: Record<Exclude<LanguageStyleId, 'standard'>, SpeakingStyle> = {
  'northern-thai': {
    id: 'northern-thai',
    displayName: 'ภาษาเหนือ',
    summary: 'ไทยมาตรฐานเป็นหลัก แทรกคำเมืองเล็กน้อยอย่างเป็นธรรมชาติ เอกสารทางการยังเป็นภาษาไทยมาตรฐาน',
    defaultIntensity: 0.55,
    version: '0.1',
    fragment: `Use a light Northern Thai / Chiang Mai conversational language style.

Keep Standard Thai as the primary language and naturally add a small amount
of Northern Thai vocabulary and sentence rhythm where appropriate.

Examples of acceptable words include:
เฮา, ผ่อ, บ่, อะหยัง, หื้อ, เน้อ, ก่อ.

Do not force dialect into every sentence.
Do not caricature, exaggerate, or imitate an accent.
Clarity is more important than dialect authenticity.

For formal artifacts such as TORs, policies, official letters, reports,
contracts, or external documents, keep the artifact itself in appropriate
Standard Thai unless the user explicitly requests Northern Thai.

This language style changes wording only and must never change facts,
reasoning, authority, safety, privacy, sources, skills, or playbooks.`,
  },
};

/** The four First Run presets; each sets the conversation tone. */
export const PERSONALITIES: Record<Personality, { label: string; summary: string; tone: string }> = {
  coworker: {
    label: 'เพื่อนร่วมงาน',
    summary: 'เป็นกันเอง สุภาพ พูดธรรมชาติ',
    tone: 'เป็นกันเอง สุภาพ พูดธรรมชาติ ไม่ใช้ภาษาทางการเกินจำเป็น',
  },
  professional: {
    label: 'มืออาชีพ',
    summary: 'สุภาพ มีโครงสร้าง ชัดเจน',
    tone: 'สุภาพ มีโครงสร้าง ชัดเจน เหมาะกับงานองค์กร',
  },
  concise: {
    label: 'กระชับ',
    summary: 'ตอบสั้น ตรงประเด็น',
    tone: 'ตอบสั้น ตรงประเด็น เน้นสิ่งที่ต้องทำต่อ',
  },
  custom: { label: 'กำหนดเอง', summary: 'เขียนสไตล์ที่ต้องการ', tone: '' },
};
export const DEFAULT_ASSISTANT = 'STeP Mate';
export const DEFAULT_PROFILE: Omit<MemberProfile, 'tenant_id' | 'user_id'> = {
  display_name: '',
  team: '',
  avatar: '',
  assistant_name: '',
  chat_language: 'auto',
  personality: 'coworker',
  assistant_tone: '',
  interaction_style: 'standard',
  language_style: 'standard',
};
/** Avatar ids match the bundled drawings avatar-01 … avatar-56; three near-copies stay valid but are not offered. */
export const AVATAR_IDS = Array.from({ length: 56 }, (_, i) => `avatar-${String(i + 1).padStart(2, '0')}`);
export const RETIRED_AVATAR_IDS = ['avatar-30', 'avatar-34', 'avatar-35'];

const line = (value: unknown, max: number) =>
  String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, max);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/** A stored or submitted profile with every field bounded and unknown choices returned to their default. */
export function normalizeProfile(input: Partial<MemberProfile> | null | undefined) {
  const p = input || {};
  return {
    display_name: line(p.display_name, 60),
    team: /^[a-z0-9-]{1,20}$/.test(String(p.team || '')) ? String(p.team) : '',
    avatar: AVATAR_IDS.includes(String(p.avatar)) ? String(p.avatar) : '',
    assistant_name: line(p.assistant_name, 60),
    chat_language: oneOf<ChatLanguage>(p.chat_language, ['auto', 'th', 'en'], 'auto'),
    personality: oneOf<Personality>(
      p.personality,
      ['coworker', 'professional', 'concise', 'custom'],
      'coworker',
    ),
    assistant_tone: line(p.assistant_tone, 300),
    interaction_style: oneOf<InteractionStyleId>(
      p.interaction_style,
      ['standard', 'witty', 'ob-oon'],
      'standard',
    ),
    language_style: oneOf<LanguageStyleId>(p.language_style, ['standard', 'northern-thai'], 'standard'),
  };
}
export const assistantName = (profile: Partial<MemberProfile> | null | undefined) =>
  line(profile?.assistant_name, 60) || DEFAULT_ASSISTANT;

/**
 * System-prompt lines for the employee's own preferences. They come after the organization rules, and the first
 * line says they rank below them, as in Desktop's Assistant Preferences and speaking-style layer.
 */
export function profileRules(input: Partial<MemberProfile> | null | undefined): string {
  const p = normalizeProfile(input);
  const tone =
    p.personality === 'custom'
      ? p.assistant_tone || PERSONALITIES.coworker.tone
      : PERSONALITIES[p.personality].tone;
  const lines = [
    'Personal preferences (set by this employee; wording only). Organization rules, sources, authority, approvals and privacy above take precedence.',
    `- Assistant name: ${assistantName(p)}. Use it only when asked who you are; do not sign answers with it.`,
  ];
  if (p.display_name)
    lines.push(
      `- The employee prefers to be called: ${p.display_name}. Do not repeat the name in every answer.`,
    );
  if (p.team) lines.push(`- Main team: ${p.team.toUpperCase()}. This is context only and grants no access.`);
  lines.push(`- Conversation tone: ${tone}`);
  lines.push(
    p.chat_language === 'th'
      ? '- Chat language: Thai, unless the request asks for another language.'
      : p.chat_language === 'en'
        ? '- Chat language: English, unless the request asks for another language.'
        : '- Chat language: the language the employee writes in.',
  );
  lines.push('- Document style: follow the selected Skill and its document standard.');
  const styles = [
    p.interaction_style !== 'standard' && INTERACTION_STYLES[p.interaction_style],
    p.language_style !== 'standard' && LANGUAGE_STYLES[p.language_style],
  ].filter((style): style is SpeakingStyle => Boolean(style));
  if (styles.length)
    lines.push(
      'Speaking style (user-selected, wording only). It ranks below every rule above: governance, authority and approvals, sources of truth, Skills and the task itself. It applies to chat text; a draft or formal document keeps its Skill’s document standard. Where it overlaps the conversation tone above, follow this speaking style.',
      ...styles.map((style) => style.fragment),
    );
  return lines.join('\n');
}
