// Context for the document tools, as the Desktop host assembles it (desktop/electron/service.ts): the primary Skill is
// chosen as usual; this adds the supporting Skills, the working template and the drafting references named by the
// tool's allowlist, resolved by their imported path. Everything here is a working reference, never policy or approval.
import { DOCUMENT_TOOLS, documentTool, type DocumentToolId } from '../vendor/desktop/document-tools.ts';
import { documentToolRule } from '../vendor/desktop/document-contract.ts';
import { LIMITS, untrusted } from './index.ts';
import type { Skill, SourceRef } from './contracts.ts';
import type { RegisteredSource } from './skill-context.ts';

export const DOCUMENT_TOOL_IDS = DOCUMENT_TOOLS.map((t) => t.id);
export const isDocumentTool = (value: unknown): value is DocumentToolId =>
  DOCUMENT_TOOL_IDS.includes(value as DocumentToolId);

const pathOf = (source: RegisteredSource) => String(source.provenance.path || '');
/** Resolve `../a/b.md` against the directory of `from`, as the Harness repository lays its files out. */
function resolvePath(from: string, link: string) {
  const parts = from.split('/').slice(0, -1);
  for (const piece of link.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece && piece !== '.') parts.push(piece);
  }
  return parts.join('/');
}
/**
 * Some Skills keep one central copy of a template and ship a short pointer file in its place
 * ("แม่แบบ ๑๖ หัวข้ออยู่ที่ [Working template กลาง](../../../common/...)"). Follow such pointers one hop.
 */
export function pointerTargets(source: RegisteredSource, registered: RegisteredSource[]) {
  if (source.body.length > 1500) return [];
  const targets: RegisteredSource[] = [];
  for (const match of source.body.matchAll(/\]\(([^)\s]+\.md)\)/g)) {
    const path = resolvePath(pathOf(source), match[1]);
    const target = registered.find((s) => pathOf(s) === path && s.source_key !== source.source_key);
    if (target && !targets.includes(target)) targets.push(target);
  }
  return targets;
}

export function documentContext(id: DocumentToolId, skills: Skill[], registered: RegisteredSource[]) {
  const tool = documentTool(id);
  if (!tool) throw new Error('INVALID_DOCUMENT_TOOL');
  const parts: string[] = [],
    sources: SourceRef[] = [],
    gaps: string[] = [];
  for (const key of tool.supportSkills) {
    const skill = skills.find((s) => s.skill_key === key);
    if (skill) parts.push(`Skill ร่วม (รูปแบบและการตรวจเอกสาร): ${skill.title}\n${skill.instructions}`);
    else gaps.push(`Skill ${key}`);
  }
  const loaded = new Set<string>();
  const add = (source: RegisteredSource, label: string) => {
    if (loaded.has(source.source_key)) return;
    loaded.add(source.source_key);
    const body = source.body.slice(0, 8000);
    parts.push(
      untrusted(
        source.source_key,
        `${label} · ${pathOf(source)} · แบบทำงาน ไม่ใช่ข้อกำหนดที่ได้รับอนุมัติ\n${body}${
          body.length < source.body.length ? '\n[แสดงข้อความบางส่วน]' : ''
        }`,
      ),
    );
    sources.push({
      id: source.source_key,
      title: pathOf(source).split('/').slice(-2).join('/') || source.title,
      location: label,
      version: source.source_version,
      kind: 'organization',
    });
  };
  for (const [path, label] of [
    [tool.template, 'แม่แบบทำงาน'] as const,
    ...tool.references.map((p) => [p, 'เอกสารอ้างอิงงานร่าง'] as const),
  ]) {
    const source = registered.find((s) => pathOf(s) === path);
    if (!source) {
      gaps.push(path);
      continue;
    }
    add(source, label);
    for (const target of pointerTargets(source, registered)) add(target, label);
  }
  if (gaps.length)
    parts.push(
      untrusted(
        'ไฟล์งานร่างที่ยังไม่พร้อม',
        `ยังไม่มีในระบบ: ${gaps.join(', ')} บันทึกช่องว่างนี้ใน document_review และไม่เติมเนื้อหาของไฟล์ที่ขาดจากความรู้ทั่วไป`,
      ),
    );
  return { parts, sources };
}

/** The system prompt for a chat run: organization rules, then the drafting contract, then personal preferences. */
export function chatSystem(rules: string, documentToolId?: DocumentToolId, preferences?: string) {
  return [rules, documentToolId && documentToolRule(documentToolId), preferences]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Longer document answers stay inside the cost the run reserved: the reservation assumes 64k input and 4,096 output
 * tokens, while actual input is capped at the context limit, so the difference may pay for more output.
 */
export function documentOutputTokens(reservedCents: number, inputRate: number, outputRate: number) {
  if (!(outputRate > 0) || !(reservedCents > 0)) return LIMITS.outputTokens;
  const affordable = Math.floor((reservedCents * 1_000_000 - LIMITS.contextTokens * inputRate) / outputRate);
  return Math.max(LIMITS.outputTokens, Math.min(8192, affordable));
}
