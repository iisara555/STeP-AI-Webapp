import { documentText, type DraftNode } from './draft.ts';
import { DOCUMENT_PRESETS, type DocumentPresentation } from './document-presentation.ts';

// Working STeP layout distilled from the owner-supplied purchase/service TOR examples.
// These are presentation choices, not procurement requirements or approved signing authority.
export const TOR_ORGANIZATION = 'อุทยานวิทยาศาสตร์และเทคโนโลยี มหาวิทยาลัยเชียงใหม่';
export const TOR_LAYOUT = { titleExtra: 2, headerCm: 1, footerCm: 1, logoWidthCm: 3, logoHeightCm: (3 * 60) / 226 };

export function torPreset(presentation: DocumentPresentation) {
  const preset = DOCUMENT_PRESETS[presentation.preset];
  // The owner-supplied TOR examples indent narrative 1.25 cm, not the 2.5 cm of a saraban letter or memo.
  return {
    ...preset,
    line: presentation.preset === 'saraban' ? 1.15 : preset.line,
    indent: presentation.preset === 'saraban' ? 1.25 : preset.indent,
  };
}

export function torSubject(document: DraftNode) {
  const blocks = document.content || [];
  const section = blocks.findIndex((node, index) => index > 0 && node.type === 'heading');
  return blocks
    .slice(0, section < 0 ? blocks.length : section)
    .find(
      node =>
        node.type === 'paragraph' && /^(?:ชื่อ(?:งาน|โครงการ)|(?:งาน)?(?:จัดซื้อ|ซื้อ|จ้าง|เช่า)|โครงการ)/.test(documentText(node).trim()),
    );
}

export function torFooterText(document: DraftNode, presentation: DocumentPresentation) {
  return (
    presentation.footerText ||
    documentText(torSubject(document) || document.content?.[0] || { type: 'paragraph' })
      .replace(/\s+/g, ' ')
      .slice(0, 100)
  );
}

// A clause label at the start of a line: ๑. / ๑) / ๑.๑ / ๑.๑.๑ (Thai or Arabic digits) or (๑).
const CLAUSE = /^([0-9๐-๙]+(?:\.[0-9๐-๙]+)+\.?|[0-9๐-๙]+[.)]|\([0-9๐-๙]+\))[ \t]+/;
/**
 * Fixed label column per clause level, so every sibling's text starts at the same place and each level's label
 * starts where its parent's text starts (๑. → ๑.๑ → ๑.๑.๑), as in STeP's TOR examples.
 */
// Wide enough for two-digit labels at each level (๑๖. / ๒.๑๐ / ๒.๑.๑๐) at 16 pt.
export const TOR_CLAUSE_CM = [0.8, 1.1, 1.45, 1.6, 1.6] as const;
// "(๑)" items take the level below the clause they follow; the pass that prepares the document records it here.
const parenthesisLevel = new WeakMap<DraftNode, number>();
const clauseLevel = (label: string, node: DraftNode) =>
  label.startsWith('(') ? (parenthesisLevel.get(node) ?? 2) : label.replace(/[.)]$/, '').split('.').length;

const startsClause = (nodes: DraftNode[]) =>
  CLAUSE.test(
    nodes
      .map(n => n.text || '')
      .join('')
      .trimStart(),
  );
const trimStart = (nodes: DraftNode[]) => {
  const out = [...nodes];
  while (out[0]?.type === 'text' && !out[0].text?.trim()) out.shift();
  if (out[0]?.type === 'text') out[0] = { ...out[0], text: out[0].text!.replace(/^\s+/, '') };
  return out;
};

/**
 * Presentation-only pass before a TOR is laid out: a clause written on the next line of the same paragraph (a line
 * break, not a new paragraph) becomes its own paragraph, and a bullet list whose items already carry clause labels
 * ("- (๑) …") loses the extra bullet. Text and marks are kept exactly; the saved draft is not changed.
 */
export function torClauseDocument(document: DraftNode): DraftNode {
  const blocks: DraftNode[] = [];
  for (const node of document.content || []) {
    if (['paragraph', 'heading'].includes(node.type) && node.content?.some(c => c.type === 'hardBreak')) {
      const lines: DraftNode[][] = [[]];
      for (const child of node.content) child.type === 'hardBreak' ? lines.push([]) : lines.at(-1)!.push(child);
      let current: DraftNode | undefined;
      for (const [index, line] of lines.entries()) {
        if (index === 0) current = { ...node, content: line };
        else if (startsClause(line)) {
          blocks.push(current!);
          current = { type: 'paragraph', content: trimStart(line) };
        } else current!.content!.push({ type: 'hardBreak' }, ...line);
      }
      blocks.push(current!);
      continue;
    }
    const items = node.type === 'bulletList' ? node.content || [] : [];
    if (items.length && items.every(item => item.content?.[0]?.type === 'paragraph' && startsClause(item.content[0].content || []))) {
      for (const item of items) blocks.push(...(item.content || []));
      continue;
    }
    blocks.push(node);
  }
  let level = 1;
  for (const node of blocks) {
    if (!['paragraph', 'heading'].includes(node.type)) continue;
    const label = CLAUSE.exec(documentText(node))?.[1];
    if (!label) continue;
    if (label.startsWith('(')) parenthesisLevel.set(node, Math.min(level + 1, TOR_CLAUSE_CM.length));
    else level = clauseLevel(label, node);
  }
  return { ...document, content: blocks };
}

/** Split only the presentation of a supplied numeric label, retaining every character and rich-text mark. */
export function torNumberedBlock(node: DraftNode) {
  if (!['paragraph', 'heading'].includes(node.type)) return undefined;
  const match = CLAUSE.exec(documentText(node));
  if (!match || match[1].length > 32) return undefined;
  const label = match[1],
    level = Math.min(clauseLevel(label, node), TOR_CLAUSE_CM.length);
  const leftCm = TOR_CLAUSE_CM.slice(0, level - 1).reduce((sum, width) => sum + width, 0);
  // A label longer than its level's column (๑๒.๑๐.๑๐) widens only its own line rather than overrunning the text.
  // Approximate printed width at 16 pt: digits ~0.26 cm, dots and brackets ~0.12-0.15 cm, plus the gap before the text.
  const printed = [...label].reduce((sum, c) => sum + (/[0-9๐-๙]/.test(c) ? 0.26 : c === '.' ? 0.12 : 0.15), 0.15);
  // "(๑)"–"(๑๙)" are short, so they keep a narrower column of their own instead of the deeper level's width.
  const widthCm = Math.max(label.startsWith('(') ? 1 : TOR_CLAUSE_CM[level - 1], printed);
  let offset = 0;
  const prefix: DraftNode[] = [],
    body: DraftNode[] = [];
  for (const child of node.content || []) {
    const text = child.text || '';
    if (child.type !== 'text') {
      body.push(child);
      continue;
    }
    const split = Math.max(0, Math.min(text.length, match[0].length - offset));
    if (split) prefix.push({ ...child, text: text.slice(0, split) });
    if (split < text.length) body.push({ ...child, text: text.slice(split) });
    offset += text.length;
  }
  return { leftCm, widthCm, prefix: { ...node, content: prefix }, body: { ...node, content: body } };
}
