import { fromMarkdown } from 'mdast-util-from-markdown';

export type DraftNode = {
  type: string;
  text?: string;
  attrs?: { level?: number; start?: number; assetId?: string; widthCm?: number; alt?: string };
  marks?: { type: string }[];
  content?: DraftNode[];
};
export const plainDocument = (text: string): DraftNode => ({
  type: 'doc',
  content: text.split('\n').map(line => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })),
});

// Inline Markdown to text runs: bold and italic survive; code, links, and escapes become plain text.
function inline(text: string): DraftNode[] {
  // This parser reads inline content (including heading labels), never a new ordered-list block.
  text = text.replace(/^(\d{1,4})([.)])(?=\s)/, (_match, number, punctuation) => number + '\\' + punctuation);
  const addMark = (marks: { type: string }[], type: string) => (marks.some(mark => mark.type === type) ? marks : [...marks, { type }]);
  const flatten = (node: any, marks: { type: string }[] = []): DraftNode[] => {
    if (node.type === 'image') return [{ type: 'text', text: text.slice(node.position.start.offset, node.position.end.offset) }];
    if (node.type === 'break') return [{ type: 'hardBreak' }];
    if (node.type === 'html' && /^<br\s*\/?>$/i.test(node.value)) return [{ type: 'hardBreak' }];
    if (typeof node.value === 'string') {
      // Preserve legacy emphasis next to identifiers (CommonMark treats **name_**suffix as literal).
      // Escaped source characters remain literal; stripping markers before privacy review must not split an email.
      const raw = text.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? text.length);
      if (node.type === 'text' && raw === node.value && !raw.includes('\\')) {
        const pattern = /(\*\*|__)(.+?)\1/g;
        const parts: DraftNode[] = [];
        let start = 0;
        for (const match of raw.matchAll(pattern)) {
          if (match.index! > start) parts.push({ type: 'text', text: raw.slice(start, match.index), ...(marks.length ? { marks } : {}) });
          parts.push({ type: 'text', text: match[2], marks: addMark(marks, 'bold') });
          start = match.index! + match[0].length;
        }
        if (start) {
          if (start < raw.length) parts.push({ type: 'text', text: raw.slice(start), ...(marks.length ? { marks } : {}) });
          return parts;
        }
      }
      return [{ type: 'text', text: node.value, ...(marks.length ? { marks } : {}) }];
    }
    const mark = node.type === 'strong' ? 'bold' : node.type === 'emphasis' ? 'italic' : undefined;
    return (node.children || []).flatMap((child: any) => flatten(child, mark ? addMark(marks, mark) : marks));
  };
  return flatten(fromMarkdown(text));
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
/** A GFM delimiter row under a header: pipes, hyphens, colons and spaces only, e.g. |---|:-:|. */
const isTableRule = (line: string) => /^[\s|:-]+$/.test(line) && line.includes('|') && line.includes('-');
const hardBreak = (line: string) => / {2}$/.test(line) || (line.match(/\\+$/)?.[0].length || 0) % 2 === 1;
const withoutBreak = (line: string) => (hardBreak(line) ? line.replace(/ {2}$|\\$/, '') : line);
export const MAX_TABLE_ROWS = 500;
export const MAX_TABLE_COLUMNS = 30;

/** A Markdown table row's cells; `\|` stays a literal pipe inside a cell. */
function tableCells(row: string) {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim().replace(/\\\|/g, '|'))
    .slice(0, MAX_TABLE_COLUMNS);
}

/** A GFM table (header row, rule, body rows) as a draft table; every row is padded to the header's width. */
function tableNode(rows: string[][]): DraftNode {
  const width = Math.max(...rows.map(row => row.length));
  return {
    type: 'table',
    content: rows.slice(0, MAX_TABLE_ROWS).map((row, index) => ({
      type: 'tableRow',
      content: Array.from({ length: width }, (_, column) => ({
        type: index === 0 ? 'tableHeader' : 'tableCell',
        content: [{ type: 'paragraph', content: inline(row[column] || '') }],
      })),
    })),
  };
}

// Model output is Markdown; map the subset the draft schema supports and keep everything else as plain paragraphs.
export function markdownDocument(markdown: string): DraftNode {
  const doc: DraftNode = { type: 'doc', content: [] };
  const lists: { node: DraftNode; indent: number }[] = [];
  let fenced = false;
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  for (let at = 0; at < lines.length; at++) {
    const raw = lines[at];
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      lists.length = 0;
      continue;
    }
    if (fenced) {
      doc.content!.push({ type: 'paragraph', content: raw ? [{ type: 'text', text: raw }] : [] });
      continue;
    }
    const item = /^(\s*)([-*+]|\d{1,4}[.)])\s+(.*)$/.exec(raw);
    if (item && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      const indent = item[1].replace(/\t/g, '  ').length,
        ordered = /\d/.test(item[2]),
        type = ordered ? 'orderedList' : 'bulletList';
      while (lists.length && (lists.at(-1)!.indent > indent || (lists.at(-1)!.indent === indent && lists.at(-1)!.node.type !== type)))
        lists.pop();
      const top = lists.at(-1);
      // A deeper indent nests under the previous item, up to four levels; deeper items stay at the last level.
      if (!top || (top.indent < indent && lists.length < 4)) {
        const list: DraftNode = {
          type,
          content: [],
          ...(ordered ? { attrs: { start: Math.min(Math.max(parseInt(item[2], 10) || 1, 1), 10000) } } : {}),
        };
        const parent = top?.node.content?.at(-1);
        if (parent) parent.content!.push(list);
        else doc.content!.push(list);
        lists.push({ node: list, indent });
      }
      lists.at(-1)!.node.content!.push({ type: 'listItem', content: [{ type: 'paragraph', content: inline(item[3]) }] });
      continue;
    }
    lists.length = 0;
    // A header row followed by a rule starts a table; it runs while rows keep their pipes.
    if (TABLE_ROW.test(raw) && isTableRule(lines[at + 1] || '')) {
      const rows = [tableCells(raw)];
      at += 2;
      while (at < lines.length && TABLE_ROW.test(lines[at])) rows.push(tableCells(lines[at++]));
      at--;
      doc.content!.push(tableNode(rows));
      continue;
    }
    if (raw === '\f') {
      doc.content!.push({ type: 'pageBreak' });
      continue;
    }
    if (!raw.trim() || TABLE_RULE.test(raw) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) continue;
    const asset = /^!\[((?:\\.|[^\]])*)\]\(step-asset:([a-f0-9-]{36})\)$/.exec(raw.trim());
    if (asset) {
      doc.content!.push({ type: 'image', attrs: { assetId: asset[2], widthCm: 12, alt: asset[1].replace(/\\([\\\[\]])/g, '$1') } });
      continue;
    }
    if (/^\s*>\s?/.test(raw)) {
      const quote = [raw.replace(/^\s*>\s?/, '')];
      while (at + 1 < lines.length && /^\s*>\s?/.test(lines[at + 1])) quote.push(lines[++at].replace(/^\s*>\s?/, ''));
      doc.content!.push({ type: 'blockquote', content: [{ type: 'paragraph', content: inline(quote.join(' ')) }] });
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (heading) {
      doc.content!.push(
        heading[1].length === 1 && !doc.content!.length
          ? { type: 'title', content: inline(heading[2]) }
          : { type: 'heading', attrs: { level: Math.min(heading[1].length, 3) }, content: inline(heading[2]) },
      );
      continue;
    }
    // A pipe row without a rule stays readable as one line; quotes lose their marker.
    const text = /^\s*\|.*\|\s*$/.test(raw)
      ? raw
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map(cell => cell.trim())
          .join(' · ')
      : raw.replace(/^\s*>\s?/, '');
    const fieldLine =
      /^(?:ส่วนงาน|ส่วนราชการ|ที่\s|วันที่\s|เรื่อง\s|เรียน\s|อ้างถึง|สิ่งที่ส่งมาด้วย|หน่วยงาน\s|ผู้รับผิดชอบ|ชื่อการประชุม|ครั้งที่|วัน เวลา|เริ่มประชุม|เลิกประชุม|ขอแสดงความนับถือ|ตำแหน่ง|\(|\[รอยืนยัน:)/;
    const prose = [text];
    while (
      at + 1 < lines.length &&
      !fieldLine.test(raw) &&
      !fieldLine.test(lines[at + 1]) &&
      lines[at + 1].trim() &&
      !/^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|[>|]|```|~~~)/.test(lines[at + 1]) &&
      !/^!\[.*\]\(step-asset:/.test(lines[at + 1]) &&
      !hardBreak(prose.at(-1)!)
    ) {
      prose.push(lines[++at]);
    }
    // Markdown soft newlines are spaces. Explicit Markdown hard breaks remain break nodes.
    const joined = prose.join(' ');
    const content = inline(withoutBreak(joined));
    if (hardBreak(prose.at(-1)!) && at + 1 < lines.length && lines[at + 1].trim()) {
      while (at + 1 < lines.length && lines[at + 1].trim() && !/^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|[>|])/.test(lines[at + 1])) {
        const next = lines[++at];
        content.push({ type: 'hardBreak' }, ...inline(withoutBreak(next)));
        if (!hardBreak(next)) break;
      }
    }
    doc.content!.push({ type: 'paragraph', content });
  }
  return doc;
}

// Accept a bounded schema with owned image IDs, never renderer HTML, URLs or arbitrary attributes.
export function validateDocument(value: unknown): DraftNode {
  let count = 0;
  const visit = (node: any, depth: number): DraftNode => {
    if (++count > 30000 || depth > 16 || !node || typeof node !== 'object') throw new Error('INVALID_DOCUMENT');
    const children: Record<string, string[]> = {
      doc: ['paragraph', 'heading', 'title', 'caption', 'blockquote', 'pageBreak', 'image', 'bulletList', 'orderedList', 'table'],
      title: ['text', 'hardBreak'],
      caption: ['text', 'hardBreak'],
      blockquote: ['paragraph'],
      image: [],
      pageBreak: [],
      table: ['tableRow'],
      tableRow: ['tableHeader', 'tableCell'],
      tableHeader: ['paragraph'],
      tableCell: ['paragraph'],
      paragraph: ['text', 'hardBreak'],
      heading: ['text', 'hardBreak'],
      bulletList: ['listItem'],
      orderedList: ['listItem'],
      listItem: ['paragraph', 'bulletList', 'orderedList'],
      text: [],
      hardBreak: [],
    };
    if (!Object.hasOwn(children, node.type)) throw new Error('INVALID_DOCUMENT');
    const result: DraftNode = { type: node.type };
    if (node.type === 'text') {
      if (typeof node.text !== 'string' || node.text.length > 150000) throw new Error('INVALID_DOCUMENT');
      result.text = node.text;
      if (node.marks !== undefined) {
        if (!Array.isArray(node.marks) || node.marks.length > 2 || node.marks.some((m: any) => !m || !['bold', 'italic'].includes(m.type)))
          throw new Error('INVALID_DOCUMENT');
        result.marks = node.marks.map((m: any) => ({ type: m.type }));
      }
    }
    if (node.type === 'heading') {
      if (![1, 2, 3].includes(node.attrs?.level)) throw new Error('INVALID_DOCUMENT');
      result.attrs = { level: node.attrs.level };
    }
    if (node.type === 'orderedList') {
      const start = node.attrs?.start ?? 1;
      if (!Number.isInteger(start) || start < 1 || start > 10000) throw new Error('INVALID_DOCUMENT');
      result.attrs = { start };
    }
    if (node.type === 'image') {
      const { assetId, widthCm = 12, alt = '' } = node.attrs || {};
      if (
        typeof assetId !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(assetId) ||
        typeof widthCm !== 'number' ||
        !Number.isFinite(widthCm) ||
        widthCm < 1 ||
        widthCm > 17 ||
        typeof alt !== 'string' ||
        alt.length > 500 ||
        Object.keys(node.attrs || {}).some(k => !['assetId', 'widthCm', 'alt'].includes(k))
      )
        throw new Error('INVALID_DOCUMENT');
      result.attrs = { assetId, widthCm, alt };
    }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content) || node.content.some((c: any) => !children[node.type].includes(c?.type)))
        throw new Error('INVALID_DOCUMENT');
      if (node.type === 'table' && node.content.length > MAX_TABLE_ROWS) throw new Error('INVALID_DOCUMENT');
      if (node.type === 'tableRow' && node.content.length > MAX_TABLE_COLUMNS) throw new Error('INVALID_DOCUMENT');
      result.content = node.content.map((c: any) => visit(c, depth + 1));
    }
    return result;
  };
  const doc = visit(value, 0);
  if (doc.type !== 'doc' || documentText(doc).length > 150000) throw new Error('INVALID_DOCUMENT');
  return doc;
}

export function documentText(node: DraftNode): string {
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'image') return node.attrs?.alt || '[รูปภาพ]';
  if (node.type === 'pageBreak') return '';
  // A table as tab-separated rows, which spreadsheets and the plain-text exports read as columns.
  if (node.type === 'tableRow') return (node.content || []).map(cell => documentText(cell).replace(/[\t\n]+/g, ' ')).join('\t');
  return (node.content || []).map(documentText).join(['paragraph', 'heading', 'title', 'caption'].includes(node.type) ? '' : '\n');
}

export function documentMarkdown(node: DraftNode, indent = ''): string {
  if (node.type === 'text') {
    let text = (node.text || '').replace(/([\\`*_\[\]<>])/g, '\\$1');
    for (const mark of node.marks || []) text = mark.type === 'bold' ? `**${text}**` : `*${text}*`;
    return text;
  }
  if (node.type === 'hardBreak') return '  \n';
  if (node.type === 'image') return `![${(node.attrs?.alt || '').replace(/([\\\[\]])/g, '\\$1')}](step-asset:${node.attrs?.assetId})`;
  if (node.type === 'pageBreak') return '\f';
  if (node.type === 'blockquote') return (node.content || []).map(n => '> ' + documentMarkdown(n, indent)).join('\n>\n');
  if (node.type === 'title') return '# ' + (node.content || []).map(n => documentMarkdown(n)).join('');
  if (node.type === 'caption') return (node.content || []).map(n => documentMarkdown(n)).join('');
  if (node.type === 'table') {
    const rows = (node.content || []).map(row =>
      (row.content || []).map(cell =>
        (cell.content || [])
          .map(child => documentMarkdown(child))
          .join(' ')
          .replace(/\n+/g, ' ')
          .replace(/\|/g, '\\|'),
      ),
    );
    if (!rows.length) return '';
    const line = (cells: string[]) => '| ' + cells.join(' | ') + ' |';
    return [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].map(row => indent + row).join('\n');
  }
  if (node.type === 'bulletList' || node.type === 'orderedList')
    return (node.content || [])
      .map((item, index) => {
        const prefix = node.type === 'bulletList' ? '- ' : `${(node.attrs?.start || 1) + index}. `;
        const text = (item.content || []).map(child => documentMarkdown(child, indent + '  ')).join('\n');
        return indent + prefix + text.replace(/\n/g, '\n' + indent + '  ');
      })
      .join('\n');
  const text = (node.content || [])
    .map(child => documentMarkdown(child, indent))
    .join(['paragraph', 'heading'].includes(node.type) ? '' : '\n\n');
  return node.type === 'heading' ? '#'.repeat(node.attrs?.level || 1) + ' ' + text : text;
}

export function documentImageIds(node: DraftNode): string[] {
  return [
    ...new Set([
      ...(node.type === 'image' && node.attrs?.assetId ? [node.attrs.assetId] : []),
      ...(node.content || []).flatMap(documentImageIds),
    ]),
  ];
}
