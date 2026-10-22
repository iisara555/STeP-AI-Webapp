
export type CatalogEntry = {
  id: string;
  title: string;
  path: string;
  owner?: string;
  status?: string;
  authority?: string;
  verification?: string;
  keywords?: string[];
};
export type KnowledgeSection = { id: string; title: string; path: string; heading: string; text: string; score: number };
/** A registered document as the AI sees it in the knowledge registry: what it is about and which sections it has. */
export type RegistryEntry = CatalogEntry & { summary: string; sections: string[] };
type Section = Omit<KnowledgeSection, 'score'> & {
  headGrams: Set<string>;
  bodyGrams: Set<string>;
  topicWords: Set<string>;
  headWords: Set<string>;
  roleCodes: string[];
  procedureCopy: boolean;
};

// Thai has no spaces between words, so documents and questions are compared as character trigrams.
const normalize = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
function trigrams(text: string) {
  const value = normalize(text),
    grams = new Set<string>();
  for (let i = 0; i + 3 <= value.length; i++) grams.add(value.slice(i, i + 3));
  return grams;
}
const share = (query: string[], grams: Set<string>) => query.filter(g => grams.has(g)).length / Math.max(query.length, 1);

// Native Thai word segmentation is used only as a relevance guard: common question words and a shared place
// name cannot by themselves establish the topic. Trigrams still rank Thai phrases and registered synonyms.
const wordSegmenter = new Intl.Segmenter('th', { granularity: 'word' });
const QUESTION_WORDS = new Set([
  'อะไร',
  'ไหม',
  'อย่างไร',
  'กี่',
  'ไหน',
  'ช่วย',
  'ขอ',
  'แนะนำ',
  'ทำ',
  'มี',
  'ได้',
  'ของ',
  'ที่',
  'เป็น',
  'กับ',
  'ใน',
  'ต้อง',
  'ยัง',
  'แล้ว',
  'บ้าง',
  'นี้',
  'หรือ',
  'ให้',
  'เท่าไร',
  'เท่าไหร่',
  'คือ',
  'ใคร',
  'หน่อย',
]);
function topicWords(text: string) {
  return new Set(
    [...wordSegmenter.segment(text.toLowerCase())]
      .filter(word => word.isWordLike && word.segment.length > 1 && !QUESTION_WORDS.has(word.segment))
      .map(word => word.segment),
  );
}
/** Only codes in an actual role table count as duty evidence; form titles mentioning duties do not. */
function roleCodes(text: string) {
  let roleTable = false;
  const codes: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|') || !line.trim().endsWith('|')) {
      roleTable = false;
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map(cell => cell.replace(/\*\*|`/g, '').trim());
    if (cells.some(cell => /หน้าที่|ขอบเขตบริการ|ความรับผิดชอบ/.test(cell))) {
      // A data cell mentioning duties must not turn an ordinary form register into a role table.
      if (/^(ทีม|หน่วยงาน|team|unit)$/i.test(cells[0])) {
        roleTable = true;
        continue;
      }
    }
    const code = cells[0] || '';
    if (roleTable && /^[a-z][a-z0-9]*(?:[ -][a-z0-9]+)*$/i.test(code)) codes.push(code);
  }
  return codes;
}
function requestedRole(question: string, codes: string[]) {
  return codes.some(code => new RegExp(`(^|[^a-z0-9_-])${code.replace(/ /g, '\\s+')}($|[^a-z0-9_-])`, 'i').test(question));
}

// Thai title abbreviations as people type them ("ผอ.วิน คือใคร"), spelled out the way the documents write them.
// Each needs its dot or a following space, so ordinary words that start the same way (ผอม, หนัง) are left alone.
const ABBREVIATIONS: [RegExp, string][] = [
  [/รอง\s*ผอ(?:\.|\s|$)/g, 'รองผู้อำนวยการ '],
  [/ผช\.?\s*ผอ(?:\.|\s|$)/g, 'ผู้ช่วยผู้อำนวยการ '],
  [/ผอ(?:\.|\s|$)/g, 'ผู้อำนวยการ '],
  [/ผจก(?:\.|\s|$)/g, 'ผู้จัดการ '],
  [/จนท(?:\.|\s|$)/g, 'เจ้าหน้าที่ '],
  [/หน\.\s*ทีม/g, 'หัวหน้าทีม'],
];
/** The question with its abbreviations spelled out, kept beside the original so both forms can match. */
export function expandAbbreviations(text: string) {
  let expanded = text;
  for (const [pattern, full] of ABBREVIATIONS) expanded = expanded.replace(pattern, full);
  return expanded === text ? text : text + '\n' + expanded;
}

/** Below this a question is about something the organization documents do not cover (tested on staff questions). */
export const MATCH_THRESHOLD = 0.3;
/** A match this strong answers from the documents alone; weaker matches still allow a public web search afterwards. */
export const STRONG_MATCH = 0.5;
const HISTORY_HEADING = /^(?:\d+\.\s*)?ประวัติการ(?:แก้ไข|เปลี่ยนแปลง)/;
const REVISION_QUESTION = /รุ่นล่าสุด|รุ่นปัจจุบัน|ฉบับล่าสุด|ฉบับปัจจุบัน|ใช้ฉบับไหน|\brev\b|มีผลวันไหน|วันที่บังคับใช้/i;
const MAX_SECTIONS = 4,
  MAX_CHARS = 9000,
  SECTION_CHARS = 4000;

/**
 * Finds the organization's own registered documents that answer a question, so the assistant reads them before it
 * searches the web or answers from general knowledge. Local only: documents are read from the harness, never sent
 * anywhere by this class.
 */
export class OrganizationKnowledge {
  private sections?: Promise<Section[]>;
  private revision = '';
  constructor(private sources: (CatalogEntry & { body: string })[]) {}
  async entries() {
    return this.sources.filter(entry => !['restricted', 'superseded', 'archived', 'withdrawn', 'not-provided'].includes(entry.status || ''));
  }
  private async load() {
    const entries = await this.entries();
    if (!this.sections) {
      this.sections = (async () => {
        const all: Section[] = [];
        for (const entry of entries) {
          const body = entry.body;
          const provenance = snapshotContext(body);
          for (const part of body.split(/\n(?=#{1,3} )/)) {
            const heading = /^#{1,3} (.+)/.exec(part)?.[1]?.trim() || entry.title;
            all.push({
              id: entry.id,
              title: entry.title,
              path: entry.path,
              heading,
              text: provenance + part.trim(),
              // Registered keywords are the words staff actually ask with ("ล่วงหน้ากี่วัน" for Lead Time), so they
              // count like a heading in every section of their document.
              headGrams: trigrams([entry.title, heading, ...(entry.keywords || [])].join(' ')),
              bodyGrams: trigrams(part.slice(0, 20000)),
              topicWords: topicWords([entry.title, heading, ...(entry.keywords || []), part.slice(0, 20000)].join(' ')),
              headWords: topicWords([entry.title, heading, ...(entry.keywords || [])].join(' ')),
              // A boosted answer must contain its evidence within the excerpt sent to the model.
              roleCodes: roleCodes((provenance + part.trim()).slice(0, SECTION_CHARS)),
              procedureCopy: entry.authority === 'controlled-document' && /^text-from-step-mis-pdf/.test(entry.verification || ''),
            });
          }
        }
        return all;
      })().catch(error => {
        this.sections = undefined;
        throw error;
      });
    }
    return this.sections;
  }
  /**
   * The STeP knowledge registry: every readable registered document with a one-line summary and its section headings,
   * scanned from the files themselves. Like the Skill registry, the AI sees what each document covers without reading
   * them all, then opens the one it needs with the reference tool.
   */
  async registry(): Promise<RegistryEntry[]> {
    const sections = await this.load();
    const entries = await this.entries();
    return entries
      .map(entry => {
        const own = sections.filter(s => s.id === entry.id && s.path === entry.path);
        if (!own.length) return undefined;
        const summary = documentSummary(own[0].text);
        const headings = own.slice(1).map(s => clip(s.heading, 90));
        const { body: _body, ...metadata } = entry;
        return { ...metadata, summary, sections: headings.slice(0, REGISTRY_SECTIONS) };
      })
      .filter((e): e is RegistryEntry => Boolean(e));
  }
  /** The best-matching sections, strongest first; empty when the documents do not cover the question. */
  async search(question: string): Promise<KnowledgeSection[]> {
    const expanded = expandAbbreviations(question);
    const query = [...trigrams(expanded)];
    const words = [...topicWords(expanded)];
    // A recommendation needs its requested subject, not just a matching place name later in the sentence.
    const recommendation = /^(?:ช่วย|ขอ)?\s*แนะนำ\s*(.+?)(?=\s*(?:ใน|แถว|จังหวัด)|$)/.exec(question)?.[1];
    const subject = recommendation ? [...topicWords(recommendation)] : [];
    const roleQuestion = /หน้าที่|ดูแลงาน|รับผิดชอบ|ทำอะไร|ทำงานอะไร/.test(question);
    // A question about a named team ("ทีม CC") needs a section that mentions that team.
    const identifiers = roleQuestion
      ? (question.toLowerCase().match(/[a-z][a-z0-9]*/g) || []).filter(id => !['team', 'unit'].includes(id))
      : [...question.toLowerCase().matchAll(/ทีม\s*([a-z][a-z0-9]*)/g)].map(match => match[1]);
    // Revision-history tables mention most topics of their document, so they only lead when the question is about changes.
    const historyQuestion = /แก้ไข|เปลี่ยน|ประวัติ|rev|ฉบับ|รุ่น/i.test(question);
    // Procedure texts converted from STeP MIS are copies; which revision is in force comes from the registers.
    const revisionQuestion = REVISION_QUESTION.test(question);
    if (query.length < 2) return [];
    const numbers = [...new Set(question.toUpperCase().match(/\b(?:QM|QP|WI|FM|SD)-[A-Z0-9]{2,8}-\d{1,6}\b/g) || [])];
    const exact = (text: string, number: string) => new RegExp(`\\b${number}\\b`, 'i').test(text);
    const scored = (await this.load())
      .filter(section => !numbers.length || numbers.some(number => exact(section.text, number)))
      .map(section => ({
        section,
        // A table row for the requested identifier outranks generic mentions and historic explanations.
        score: numbers.length
          ? numbers.reduce(
              (sum, number) =>
                sum + (new RegExp(`^\\|\\s*${number}\\s*\\|`, 'im').test(section.text) ? 1 : exact(section.text, number) ? 0.8 : 0),
              0,
            ) / numbers.length
          : roleQuestion && requestedRole(question, section.roleCodes)
            ? 0.85
            : (words.length && share(words, section.topicWords) < 0.5) ||
                // Long procedure copies mention much in passing; their title, heading or keywords must carry the topic.
                (section.procedureCopy && words.length && !words.some(word => section.headWords.has(word))) ||
                (subject.length && !subject.every(word => section.topicWords.has(word))) ||
                (identifiers.length && !identifiers.some(id => section.topicWords.has(id)))
              ? 0
              : (0.6 * share(query, section.headGrams) + 0.4 * share(query, section.bodyGrams)) *
                (!historyQuestion && HISTORY_HEADING.test(section.heading) ? 0.8 : 1) *
                (revisionQuestion && section.procedureCopy ? 0.7 : 1),
      }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0]?.score || 0;
    if (best < MATCH_THRESHOLD) return [];
    const picked: KnowledgeSection[] = [];
    let chars = 0;
    for (const { section, score } of scored) {
      if (picked.length >= MAX_SECTIONS || score < Math.max(MATCH_THRESHOLD, best * 0.75)) break;
      const text = section.text.length > SECTION_CHARS ? section.text.slice(0, SECTION_CHARS) + '\n…' : section.text;
      if (chars + text.length > MAX_CHARS) continue;
      chars += text.length;
      picked.push({
        id: section.id,
        title: section.title,
        path: section.path,
        heading: section.heading,
        text,
        score: Math.round(score * 100) / 100,
      });
    }
    return picked;
  }
}

/** Prompt text for the matched sections, each labelled with its registered document so answers can cite it. */
export function knowledgeText(sections: KnowledgeSection[]) {
  return sections.map(s => `[${s.id}] ${s.title}\n§ ${s.heading}\n${s.text}`).join('\n\n---\n\n');
}

const REGISTRY_SECTIONS = 16;
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text);
/** MIS rows are snapshots; preserve their capture date even when only a matching team section is sent. */
function snapshotContext(text: string) {
  const date = /^\*\*ดึงข้อมูลเมื่อ:\*\*\s*(\d{4}-\d{2}-\d{2})/m.exec(text)?.[1];
  return date && /STeP MIS/.test(text)
    ? `ข้อมูลจาก STeP MIS ณ ${date} (ภาพข้อมูล ณ วันที่ดึง; ถ้า REV หรือวันที่ต่างจากฉบับจริง ให้ยึด MIS และเปิดฉบับปัจจุบันจาก MIS)\n\n`
    : '';
}
/** The first plain sentence of a document: its purpose, without the title, metadata lines, tables or Markdown marks. */
function documentSummary(intro: string) {
  const line = intro
    .split('\n')
    .slice(1)
    .map(l => l.trim())
    .find(l => l && !/^(#|\||>|-{3}|\*\*[^*]+:\*\*|<!--)/.test(l));
  return clip((line || '').replace(/\*\*|`|\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^[-*] /, ''), 200);
}

/** One bounded line per document. Section outlines are fetched on demand with reference(args.action=outline). */
export function registryText(entries: RegistryEntry[]) {
  return entries
    .map(e => `- ${e.id} | ${clip(e.title.replace(/\s+/g, ' '), 110)} | ${clip(e.summary.replace(/\s+/g, ' '), 140)}`)
    .join('\n');
}

export function documentHeadings(text: string) {
  return [...text.matchAll(/^#{1,3} (.+)$/gm)].map(match => clip(match[1].trim(), 160)).slice(0, 100);
}

/** One section of a document by its heading (exact, then partial match); undefined when none matches. */
export function documentSection(text: string, wanted: string) {
  const parts = text.split(/\n(?=#{1,3} )/);
  const want = normalize(wanted);
  if (!want) return undefined;
  const heading = (part: string) => normalize(/^#{1,3} (.+)/.exec(part)?.[1] || '');
  const found =
    parts.find(p => heading(p) === want) || parts.find(p => heading(p) && (heading(p).includes(want) || want.includes(heading(p))));
  return found ? snapshotContext(text) + found : undefined;
}
