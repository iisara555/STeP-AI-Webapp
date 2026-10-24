import { estimateTextTokens, rankSources, untrusted } from './index.ts';
import type { Skill, SourceRef } from './contracts.ts';
import { pointerTargets } from './document-context.ts';
export interface RegisteredSource {
  source_key: string;
  title: string;
  body: string;
  source_version: string;
  provenance: Record<string, unknown>;
}
/** Skill-local working examples never become organization policies or approval evidence. */
export function skillContext(skill: Skill, registered: RegisteredSource[], query: string) {
  const parts = [`Skill ที่เลือก: ${skill.title}\n${skill.instructions}`],
    sources: SourceRef[] = [];
  const required = Array.isArray(skill.metadata.required_source_keys)
    ? skill.metadata.required_source_keys
    : [];
  const missing: string[] = [];
  const add = (source: RegisteredSource, body: string, location: string) => {
    parts.push(untrusted(source.source_key, body));
    sources.push({
      id: source.source_key,
      title: source.title,
      location,
      version: source.source_version,
      kind: 'organization',
    });
  };
  for (const key of [...new Set(required)]) {
    const source = registered.find((s) => s.source_key === key && !s.source_key.startsWith('__'));
    if (!source) {
      missing.push(String(key));
      continue;
    }
    add(source, source.body, 'แหล่งบังคับฉบับเต็ม');
  }
  if (missing.length)
    parts.push(
      untrusted(
        'แหล่งบังคับที่ยังไม่พร้อม',
        `ยังไม่มีต้นฉบับ: ${missing.join(', ')} ต้องเปิดเผยช่องว่างนี้ ไม่อ้างว่าได้ตรวจข้อกำหนดปัจจุบัน และไม่เติมกฎที่ขาดจากความรู้ทั่วไป`,
      ),
    );
  const support = Array.isArray(skill.metadata.support_source_keys) ? skill.metadata.support_source_keys : [];
  const candidates = registered.filter(
    (s) => support.includes(s.source_key) && s.provenance.kind === 'skill-support',
  );
  // Choose relevant working references, never all examples at once. Templates get preference in drafting requests.
  const ranked = rankSources(candidates, query, 3);
  const requested = candidates.filter((s) => query.includes(String(s.provenance.path)));
  const selected = [
    ...new Set([
      ...requested,
      ...(ranked.length
        ? ranked
        : candidates.filter((s) => String(s.provenance.path).includes('/templates/')).slice(0, 1)),
    ]),
  ].slice(0, 3);
  // A short pointer file names the one central copy; load that copy instead of a link the model cannot open.
  const expanded = [...new Set(selected.flatMap((s) => [s, ...pointerTargets(s, registered)]))].slice(0, 4);
  for (const source of expanded) {
    const body = source.body.slice(0, 6000);
    add(
      source,
      `เอกสารประกอบ Skill / แบบทำงาน ไม่ใช่ข้อกำหนดที่ได้รับอนุมัติ\n${body}${body.length < source.body.length ? '\n[แสดงข้อความบางส่วน]' : ''}`,
      'ส่วนประกอบ Skill',
    );
  }
  if (estimateTextTokens(parts.join('\n')).estimatedTokens > 24000) throw new Error('CONTEXT_LIMIT');
  return { parts, sources };
}
