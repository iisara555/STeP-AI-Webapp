// Adapted from upstream desktop/electron/export.ts (STeP-AI-Harness 00c61e4) for the browser: Word and the PDF page
// HTML are unchanged; files are returned instead of written, the font faces travel with the page, and the
// spreadsheet, slide and agency-template exports are not carried over. Changes are listed in ../UPSTREAM.md.
import {
  Document,
  HeadingLevel,
  Footer,
  Header,
  ImageRun,
  PageNumber,
  TableOfContents,
  NumberFormat,
  LevelFormat,
  Packer,
  Paragraph,
  AlignmentType,
  LineRuleType,
  ShadingType,
  Table,
  TableLayoutType,
  TableCell,
  TableRow,
  TextRun,
  Tab,
  TabStopType,
  WidthType,
  BorderStyle,
  VerticalAlign,
  type ParagraphChild,
  type INumberingOptions,
} from 'docx';
import { type DraftNode, documentText, markdownDocument, validateDocument } from './draft.ts';
import { documentLayoutRoles, resolveDocumentLayout, sarabanSpacing, type DocumentLayout, type LayoutRole } from './document-layout.ts';
import { GARUDA_DATA_URI, GARUDA_PNG } from './garuda-image.ts';
import { longestWordUnits, textUnits, THAI_DOCUMENT_CSS, THAI_DOCUMENT_LANGUAGE, withThaiBreaks } from './thai-typography.ts';
import { DOCUMENT_PRESETS, resolvePresentation, type DocumentPresentation } from './document-presentation.ts';
import { embedDocumentFonts, type FontFile } from './document-fonts.ts';
import { TOR_LAYOUT, torClauseDocument, torFooterText, torNumberedBlock, torPreset } from './tor-layout.ts';
import { torPdfFurniture, torWordHeader } from './tor-furniture.ts';
import { INVITATION_LAYOUT, INVITATION_RSVP_LABELS, invitationParts } from './invitation.ts';

/** Web: drafts carry no uploaded images yet; the type keeps Desktop's image paths intact. */
export type DocumentImage = { bytes: Uint8Array; width: number; height: number };
const base64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
/** Web: invitation QR codes are not drawn in the browser; the type keeps Desktop's invitation layout intact. */
type InvitationQr = { label: string; bytes: Uint8Array };

// Generic exports keep their existing font. Skill-backed DOCX uses a working document layout and an explicit face.
export const OFFICIAL_FONT = 'TH Sarabun New';
const SCREEN_FONT = 'Leelawadee UI';
const CM = 567; // twips per centimetre
/** printToPDF margins in inches, matching the Word page. */
export const PDF_MARGINS = { top: 2.5 / 2.54, bottom: 2 / 2.54, left: 3 / 2.54, right: 2 / 2.54 };

/** Front matter in a TOR is an agency/data block, not a centered title. */
const centerFrontMatter = (layout: DocumentLayout, role: LayoutRole | 'quote' | 'letter-head') =>
  role === 'front' && layout.id === 'minutes';
/**
 * หนังสือภายนอก: the ที่ line and the first paragraph of ส่วนราชการเจ้าของหนังสือ share one row, ที่ at the left margin
 * and the sender from the centre of the text column. Returns the index of the ที่ paragraph, or -1.
 */
function letterHeadRow(blocks: DraftNode[], roles: LayoutRole[], id: DocumentLayout['id'], invitation: unknown) {
  if (id !== 'letter' || invitation) return -1;
  return blocks.findIndex(
    (node, index) =>
      node.type === 'paragraph' &&
      blocks[index + 1]?.type === 'paragraph' &&
      roles[index] !== 'sender' &&
      roles[index + 1] === 'sender' &&
      /^ที่\s/.test(documentText(node).trim()),
  );
}
const letterHeadNode = (number: DraftNode, sender: DraftNode): DraftNode => ({
  type: 'paragraph',
  content: [...(number.content || []), { type: 'text', text: '\t' }, ...(sender.content || [])],
});

export function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A cell's or block's text on one line, for spreadsheets and slides. */
const flat = (node: DraftNode) => documentText(node).replace(/\s*\n\s*/g, ' ');
const tableRows = (table: DraftNode) => (table.content || []).map(row => (row.content || []).map(flat));
const hasPageBreak = (node: DraftNode): boolean => node.type === 'pageBreak' || Boolean(node.content?.some(hasPageBreak));
const AMOUNT = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;
/** Columns whose body cells are all amounts (at least one), right-aligned as figures are in Thai official tables. */
const numericColumns = (rows: string[][]) =>
  Array.from({ length: Math.max(0, ...rows.map(row => row.length)) }, (_, column) => {
    const body = rows
      .slice(1)
      .map(row => (row[column] || '').trim())
      .filter(Boolean);
    return body.length > 0 && body.every(text => AMOUNT.test(text));
  });

const TEXT_WIDTH = 11906 - 3 * CM - 2 * CM; // A4 width less the official margins, in twips
const visible = (text = '') => textUnits(text);

/**
 * Font size and column widths (twips) of a table, for Word and PDF alike. Each column first gets room for its longest
 * header word and its figures, which must not wrap; the rest of the line goes to columns with longer text. A table
 * whose header words do not fit at 16 pt drops to 14 or 12 pt, as Thai official documents do with wide tables.
 */
export function tableLayout(rows: string[][], textWidth = TEXT_WIDTH, bodyPoints = 16) {
  const count = Math.max(1, ...rows.map(row => row.length));
  const numeric = numericColumns(rows);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const sized = (points: number) => {
    const span = (chars: number) => (chars + 1) * points * 20 * 0.55 + 220;
    const minimum = Array.from({ length: count }, (_, column) => {
      const figures = numeric[column] ? rows.slice(1).map(row => visible(row[column])) : [];
      // Reserve a whole date/reference token before allocating spare width to narrative columns.
      const codes = rows
        .slice(1)
        .flatMap(row => [...(row[column] || '').matchAll(/[A-Za-z0-9๐-๙][A-Za-z0-9๐-๙._:/%+-]*/g)])
        .filter(match => /[0-9๐-๙]/.test(match[0]))
        .map(match => Math.min(32, visible(match[0])));
      return span(Math.max(2, longestWordUnits(rows[0]?.[column] || ''), ...figures, ...codes));
    });
    const desired = minimum.map((least, column) => Math.max(least, span(Math.min(Math.max(...rows.map(row => visible(row[column]))), 40))));
    return { points, minimum, desired };
  };
  const { points, minimum, desired } =
    [bodyPoints, Math.max(12, bodyPoints - 2)].map(sized).find(size => sum(size.minimum) <= textWidth) || sized(12);
  let widths: number[];
  if (sum(desired) <= textWidth) widths = desired.map(width => (width * textWidth) / sum(desired));
  else if (sum(minimum) <= textWidth) {
    const spare = textWidth - sum(minimum),
      wanted = sum(desired) - sum(minimum);
    widths = minimum.map((least, column) => least + (spare * (desired[column] - least)) / wanted);
  } else widths = minimum.map(width => (width * textWidth) / sum(minimum));
  return { points, columns: widths.map(Math.floor) };
}

function richHtml(node: DraftNode, images: ReadonlyMap<string, DocumentImage> = new Map()): string {
  if (node.type === 'pageBreak') return '<div style="break-before:page"></div>';
  if (node.type === 'image') {
    const image = images.get(node.attrs!.assetId!);
    if (!image) throw new Error('DOCUMENT_IMAGE_NOT_FOUND');
    return (
      '<figure><img alt="' +
      escapeHtml(node.attrs?.alt || '') +
      '" src="data:image/png;base64,' +
      base64(image.bytes) +
      '" style="width:' +
      (node.attrs?.widthCm || 12) +
      'cm;max-width:100%;height:auto"></figure>'
    );
  }
  if (node.type === 'caption') return '<p class="caption">' + (node.content || []).map(child => richHtml(child, images)).join('') + '</p>';

  if (node.type === 'text') {
    let text = escapeHtml(keepPhone(node.text || ''));
    for (const mark of node.marks || []) text = mark.type === 'bold' ? `<strong>${text}</strong>` : `<em>${text}</em>`;
    return text;
  }
  if (node.type === 'hardBreak') return '<br>';
  const text = (node.content || []).map(child => richHtml(child, images)).join('');
  if (node.type === 'table') {
    const text = tableRows(node);
    const numeric = numericColumns(text);
    const { points, columns } = tableLayout(text);
    const total = columns.reduce((sum, width) => sum + width, 0);
    const rows = (node.content || []).map(
      row =>
        `<tr>${(row.content || [])
          .map((cell, column) => {
            const tag = cell.type === 'tableHeader' ? 'th' : 'td';
            return `<${tag}${numeric[column] ? ' class="num"' : ''}>${(cell.content || []).map(child => richHtml(child, images)).join('')}</${tag}>`;
          })
          .join('')}</tr>`,
    );
    const colgroup = columns.map(width => `<col style="width:${((width * 100) / total).toFixed(2)}%">`).join('');
    return `<table style="font-size:${points}pt"><colgroup>${colgroup}</colgroup><thead>${rows[0] || ''}</thead><tbody>${rows.slice(1).join('')}</tbody></table>`;
  }
  const tag = (
    {
      paragraph: 'p',
      title: 'h1',
      blockquote: 'blockquote',
      bulletList: 'ul',
      orderedList: 'ol',
      listItem: 'li',
      tableRow: 'tr',
      heading: `h${node.attrs?.level || 1}`,
    } as Record<string, string>
  )[node.type];
  return tag ? `<${tag}${node.type === 'orderedList' ? ` start="${node.attrs?.start || 1}"` : ''}>${text}</${tag}>` : text;
}

function memoReferenceHtml(node: DraftNode) {
  const date = /[ \t]+(วันที่[ \t])/.exec(documentText(node));
  if (!date) return richHtml(node);
  const labelStart = date.index + date[0].length - date[1].length;
  const number: DraftNode[] = [],
    value: DraftNode[] = [];
  let offset = 0;
  for (const child of node.content || []) {
    const text = documentText(child);
    if (child.type === 'hardBreak') {
      if (offset < date.index) number.push(child);
      if (offset >= labelStart) value.push(child);
    } else {
      const before = text.slice(0, Math.max(0, date.index - offset));
      const after = text.slice(Math.max(0, labelStart - offset));
      if (before) number.push({ ...child, text: before });
      if (after) value.push({ ...child, text: after });
    }
    offset += text.length;
  }
  return `<p class="memo-reference-row"><span class="memo-number">${number.map(node => richHtml(node)).join('')}</span><span class="memo-date">${value.map(node => richHtml(node)).join('')}</span></p>`;
}

export function pdfHtml(
  document: DraftNode,
  layout = resolveDocumentLayout(),
  images: ReadonlyMap<string, DocumentImage> = new Map(),
  presentation = resolvePresentation({}, layout.id || false),
  qrs: InvitationQr[] = [],
  fontFaces = '',
) {
  // TH Sarabun New when installed (the family brings its real bold); otherwise a common Thai font scaled down to the
  // same visual size, since TH Sarabun is drawn much smaller than other fonts at the same point size.
  const face = (weight: number, names: string[]) =>
    `@font-face{font-family:"STeP Fallback";font-weight:${weight};size-adjust:72%;src:${names.map(name => `local("${name}")`).join(',')}}`;
  const style = [
    fontFaces,
    face(400, [
      'Sarabun Regular',
      'Sarabun-Regular',
      'Leelawadee UI',
      'LeelawadeeUI',
      'Thonburi',
      'Noto Sans Thai',
      'NotoSansThai-Regular',
    ]),
    face(700, [
      'Sarabun Bold',
      'Sarabun-Bold',
      'Leelawadee UI Bold',
      'LeelawadeeUI-Bold',
      'Thonburi Bold',
      'Thonburi-Bold',
      'Noto Sans Thai Bold',
      'NotoSansThai-Bold',
    ]),
    `body{font-family:"${layout.font}","STeP Fallback",sans-serif;font-size:16pt;line-height:1.35;${THAI_DOCUMENT_CSS}margin:0}`,
    'figure{margin:8pt 0;text-align:center;break-after:avoid}.caption{text-align:center;font-size:14pt;break-before:avoid}blockquote{margin:8pt 1.25cm}p{white-space:pre-wrap;margin:0 0 6pt;widows:2;orphans:2}h1{font-size:20pt}h2{font-size:18pt}h3{font-size:16pt}',
    'h1,h2,h3{margin:12pt 0 6pt;break-after:avoid}ul,ol{margin:0 0 6pt;padding-left:1.5em}',
    'table{border-collapse:collapse;width:100%;table-layout:fixed;margin:6pt 0 10pt}tr{break-inside:avoid}thead{display:table-header-group}',
    'th,td{border:0.75pt solid #444;padding:2pt 5pt;vertical-align:top;text-align:left}th{background:#eee;font-weight:bold}',
    'th p,td p{margin:0}th.num,td.num{text-align:right}',
    ...(layout.id
      ? [
          '@page{size:A4;margin:2.5cm 2cm 2cm 3cm}body{line-height:1.15}.block p{margin:0}h1,h2,h3{font-size:16pt;margin:6pt 0 3pt}.block:has(h1,h2,h3){break-after:avoid}',
          '.block.sender,.block.date,.block.front,.block.signature{break-after:avoid}',
          '.memo-reference-row,.letter-head{display:grid;grid-template-columns:1fr 1fr;break-inside:avoid}.letter-head{break-after:avoid}.memo-label{font-size:20pt}',
          `.block.title :is(h1,h2,h3){font-size:${layout.id === 'memo' ? 29 : 18}pt}`,
        ]
      : []),
    ...(layout.garudaHeightCm
      ? [
          '@page:first{margin-top:1.5cm}',
          '.letterhead{break-inside:avoid;margin-bottom:.5cm}.letterhead.letter{text-align:center;margin-left:-1cm}',
          '.letterhead.memo{position:relative;min-height:1.5cm;display:flex;align-items:flex-end;justify-content:center}',
          '.letterhead.memo img{position:absolute;left:0;bottom:0}.letterhead.memo :is(h1,h2,h3){font-size:29pt;margin:0 2cm;line-height:1.1}',
        ]
      : []),
  ].join('');
  if (layout.id === 'letter' && presentation.invitation) {
    const parts = invitationParts(document);
    const render = (nodes: DraftNode[]) => nodes.map(n => richHtml(n, images)).join('');
    const body = parts.body
      .map(
        n =>
          `<div class="invitation-block ${/^(?:เรื่อง|เรียน|อ้างถึง|สิ่งที่ส่งมาด้วย)(?:\s|$)/.test(documentText(n).trim()) ? 'field' : 'body'}${/^(?:เรื่อง|เรียน)(?:\s|$)/.test(documentText(n).trim()) ? ' hanging' : ''}">${richHtml(n, images)}</div>`,
      )
      .join('');
    return `<!doctype html><html lang="th"><meta charset="utf-8"><style>${style}
      @page{size:A4;margin:1.5cm 2cm 1.5cm 3cm}
      body{font-size:16pt;line-height:${INVITATION_LAYOUT.line}}
      .invitation-head{display:grid;grid-template-columns:6cm 3cm 7cm;align-items:start;break-inside:avoid;break-after:avoid}
      .invitation-head img{width:3cm;height:3cm;align-self:start}.invitation-head p{margin:0}
      .invitation-number,.invitation-sender{padding-top:1.8cm}.invitation-sender{padding-left:1cm}.invitation-date{text-align:center;margin:${INVITATION_LAYOUT.dateBeforeCm}cm 0 ${INVITATION_LAYOUT.dateAfterCm}cm;break-after:avoid}
      .invitation-block{margin:0 0 8pt}.invitation-block p{margin:0}
      .invitation-block.field{break-inside:avoid;break-after:avoid}
      .invitation-block.hanging>p{padding-left:${INVITATION_LAYOUT.frontHangCm}cm;text-indent:-${INVITATION_LAYOUT.frontHangCm}cm}
      .invitation-block.body>p{text-indent:2.5cm;text-align:justify}
      .invitation-signature{margin-left:4cm;width:10cm;text-align:center;break-inside:avoid;break-after:avoid}
      .invitation-signature p{margin:0}.invitation-signature p:first-child{margin-bottom:1.2cm}
      .invitation-footer{display:flex;gap:0;align-items:start;margin-top:.5cm;break-inside:avoid}
      .invitation-contact{flex:1;min-width:0}.invitation-contact p{margin:0}
      .invitation-qrs{display:flex;gap:0}.invitation-qrs figure{width:3cm;margin:0;text-align:center}
      .invitation-qrs img{width:2.5cm;height:2.5cm}.invitation-qrs figcaption{font-size:12pt}
      </style><body><header class="invitation-head"><div class="invitation-number">${render(parts.number)}</div><img alt="ตราครุฑ" src="${GARUDA_DATA_URI}"><div class="invitation-sender">${render(parts.sender)}</div></header>
      <div class="invitation-date">${render(parts.date)}</div>${body}
      <div class="invitation-signature">${render(parts.signature)}</div>
      <section class="invitation-footer"><div class="invitation-contact">${render(parts.contact)}</div><div class="invitation-qrs">${qrs.map(q => `<figure><img alt="${escapeHtml(q.label)}" src="data:image/png;base64,${base64(q.bytes)}"><figcaption>${escapeHtml(q.label)}</figcaption></figure>`).join('')}</div></section></body></html>`;
  }
  const blocks = document.content || [];
  const title =
    layout.id === 'memo' && layout.garudaHeightCm && ['heading', 'title'].includes(blocks[0]?.type || '') ? blocks[0] : undefined;
  const roles = documentLayoutRoles(document, layout.id);
  const spacing = sarabanSpacing(document, layout.id);
  const tor = layout.id === 'tor' ? torPdfFurniture(document, layout.font, presentation) : undefined;
  const torStyle = tor ? torPreset(presentation) : undefined;
  const head = letterHeadRow(blocks, roles, layout.id, presentation.invitation);
  const content = layout.id
    ? blocks
        .map((node, index) => {
          if (node === title || (head >= 0 && index === head + 1)) return '';
          if (index === head)
            return `<div class="block letter-head" style="${spacing[index] ? `margin-top:${spacing[index]}pt;` : ''}"><div>${richHtml(node, images)}</div><div>${richHtml(blocks[index + 1], images)}</div></div>`;
          const role = roles[index];
          const css =
            ['title', 'subject', 'signature', 'date'].includes(role) || centerFrontMatter(layout, role)
              ? 'text-align:center;'
              : 'text-align:left;';
          const indent = ['sender', 'signature'].includes(role)
            ? 'margin-left:8cm;'
            : role === 'body' && node.type === 'paragraph'
              ? `text-indent:${torStyle ? torStyle.indent : 2.5}cm;text-align:justify;`
              : '';
          const numbered = tor && torNumberedBlock(node);
          const inner = numbered
            ? `<div class="tor-numbered" style="margin-left:${numbered.leftCm}cm;grid-template-columns:${numbered.widthCm}cm minmax(0,1fr)"><span>${richHtml(numbered.prefix, images)}</span><span>${richHtml(numbered.body, images)}</span></div>`
            : role === 'memo-reference'
              ? memoReferenceHtml(node)
              : richHtml(node, images);
          const labelled =
            layout.id === 'memo' && (role === 'memo-reference' || role === 'field')
              ? inner
                  .replace(
                    /^(<p[^>]*>(?:<span class="memo-number">)?)(ส่วนราชการ|ส่วนงาน|ที่|เรื่อง)(?=[ \t])/,
                    '$1<b class="memo-label">$2</b>',
                  )
                  .replace(/(<span class="memo-date">)(วันที่)(?=[ \t])/, '$1<b class="memo-label">$2</b>')
              : inner;
          const before = spacing[index] ? `margin-top:${spacing[index]}pt;` : '';
          return `<div class="block ${role}${tor && node.type === 'heading' && role !== 'title' ? ' section-heading' : ''}" style="${css}${numbered ? '' : indent}${before}">${labelled}</div>`;
        })
        .join('')
    : richHtml(document, images);
  const letterhead = layout.garudaHeightCm
    ? `<div class="letterhead ${layout.id}"><img alt="ตราครุฑ" src="${GARUDA_DATA_URI}" style="height:${layout.garudaHeightCm}cm;width:${layout.garudaHeightCm}cm">${title ? richHtml(title) : ''}</div>`
    : '';
  const torCss = torStyle
    ? `${tor!.css}
    @page{margin:${torStyle.margins.top}cm ${torStyle.margins.right}cm ${torStyle.margins.bottom}cm ${torStyle.margins.left}cm}
    body{font-size:${torStyle.points}pt;line-height:${torStyle.line}}
    .block.title :is(h1,h2,h3){font-size:${torStyle.points + TOR_LAYOUT.titleExtra}pt;margin:0 0 6pt}
    .block.subject{font-weight:bold;margin-bottom:3pt}
    .block :is(h1,h2,h3){font-size:${torStyle.points}pt}
    .tor-numbered{display:grid;text-align:justify;break-inside:auto}
    .tor-numbered :is(p,h1,h2,h3){margin:0;text-indent:0;font-size:inherit}
    .section-heading{font-weight:bold;margin:8pt 0 3pt;break-after:avoid}
    .section-heading .tor-numbered{text-align:left}
    .tor-numbered span{min-width:0}
    .block.signature{text-indent:0;break-inside:avoid}
    th{background:#f2f2f2}th,td{border-color:#777}
  `
    : '';
  // Continuation pages carry "- ๒ -" centred at the top; page 1 has none (the saraban print explanation).
  const sarabanCss =
    layout.id && !tor && !presentation.invitation && presentation.pageNumber === 'saraban'
      ? `@page{@top-center{content:"- " counter(page, thai) " -";font-family:"${layout.font}","STeP Fallback",sans-serif;font-size:16pt;vertical-align:bottom;padding-bottom:.4cm}}@page:first{@top-center{content:none}}`
      : '';
  return `<!doctype html><html lang="th"><meta charset="utf-8"><style>${style}${torCss}${sarabanCss}</style><body>${letterhead}${content}</body></html>`;
}

/** Memo header labels print bold at 20 pt, as the saraban print explanation sets them; values keep the body size. */
const MEMO_LABEL = /^(?:ส่วน\u200b?ราชการ|ส่วน\u200b?งาน|ที่|เรื่อง)(?=[ \t])/;
const MEMO_LABEL_SIZE = 40;
/** A spaced Thai phone number ("๐ ๕๓๒๐ ๐๐๐๐", "0 5320 0000") stays on one line in the exported copy only. */
const keepPhone = (text: string) => text.replace(/(^|[^0-9๐-๙])([0๐]) ([0-9๐-๙]{4}) ([0-9๐-๙]{4})(?![0-9๐-๙])/g, '$1$2\u00a0$3\u00a0$4');

function runs(
  node: DraftNode,
  size: number,
  bold = false,
  font = OFFICIAL_FONT,
  dateTab = false,
  thaiBreaks = false,
  memoLabels = false,
): ParagraphChild[] {
  if (thaiBreaks) node = withThaiBreaks(node);
  const plain = documentText(node);
  // Locate the label across rich-text runs, rather than matching a word inside its placeholder/value.
  // Thai line-break opportunities (U+200B) may sit inside the label, so the label tolerates them.
  const date = dateTab ? /[ \t]+(วัน\u200b?ที่[ \t])/.exec(plain.split(/\r\n?|\n/)[0]) : null;
  const spaceStart = date?.index ?? -1;
  const labelStart = date ? date.index + date[0].length - date[1].length : -1;
  const labels: [number, number][] = [];
  if (memoLabels) {
    const lead = MEMO_LABEL.exec(plain);
    if (lead) labels.push([0, lead[0].length]);
    if (date) labels.push([labelStart, labelStart + date[1].trimEnd().length]);
  }
  let offset = 0;
  return (node.content || []).flatMap(child => {
    if (child.type === 'hardBreak') {
      offset++;
      return [new TextRun({ break: 1 })];
    }
    const style = {
      font,
      size,
      bold: bold || child.marks?.some(m => m.type === 'bold'),
      sizeComplexScript: size,
      boldComplexScript: bold || child.marks?.some(m => m.type === 'bold'),
      italics: child.marks?.some(m => m.type === 'italic'),
      italicsComplexScript: child.marks?.some(m => m.type === 'italic'),
      language: THAI_DOCUMENT_LANGUAGE,
    };
    const label = { bold: true, boldComplexScript: true, size: MEMO_LABEL_SIZE, sizeComplexScript: MEMO_LABEL_SIZE };
    const pieces = (value: string, at: number): ParagraphChild[] =>
      value
        .split(/(\t|\r\n?|\n)/)
        .filter(Boolean)
        .map(
          part =>
            new TextRun({
              ...style,
              ...(part === '\t' ? { children: [new Tab()] } : /^[\r\n]/.test(part) ? { break: 1 } : { text: keepPhone(part) }),
              ...(labels.some(([from, to]) => at >= from && at < to) && !/^[\t\r\n]/.test(part) ? label : {}),
            }),
        );
    // Split a run at label edges so only the label takes the label style.
    const textRuns = (value: string, at: number): ParagraphChild[] => {
      const cuts = [...new Set(labels.flat().filter(edge => edge > at && edge < at + value.length))].sort((a, b) => a - b);
      const parts: ParagraphChild[] = [];
      let from = at;
      for (const edge of [...cuts, at + value.length]) {
        if (edge > from) parts.push(...pieces(value.slice(from - at, edge - at), from));
        from = edge;
      }
      return parts;
    };
    const text = child.text || '';
    const start = offset;
    offset += text.length;
    // Layout only: retain all field characters, including unknown dates and leading zeroes.
    return date && start < labelStart && offset > spaceStart
      ? [
          ...textRuns(text.slice(0, Math.max(0, spaceStart - start)), start),
          ...(start <= spaceStart ? [new TextRun({ ...style, children: [new Tab()] })] : []),
          ...textRuns(text.slice(Math.max(0, labelStart - start)), Math.max(start, labelStart)),
        ]
      : textRuns(text, start);
  });
}

type WordLayout = DocumentLayout & {
  qrs?: InvitationQr[];
  presentation: DocumentPresentation;
  images: ReadonlyMap<string, DocumentImage>;
  lists: Map<DraftNode, string>;
};
const wordPreset = (layout: WordLayout) =>
  layout.id === 'letter' && layout.presentation.invitation
    ? INVITATION_LAYOUT
    : layout.id === 'tor'
      ? torPreset(layout.presentation)
      : DOCUMENT_PRESETS[layout.presentation.preset];
const wordWidth = (layout: WordLayout) => 11906 - Math.round((wordPreset(layout).margins.left + wordPreset(layout).margins.right) * CM);

function docxTable(table: DraftNode, layout: WordLayout) {
  const font = layout.font,
    textWidth = wordWidth(layout);
  const rows = table.content || [];
  const text = tableRows(table);
  const width = Math.max(1, ...rows.map(row => (row.content || []).length));
  const numeric = numericColumns(text);
  const { points, columns } = tableLayout(text, textWidth, wordPreset(layout).points);
  const size = points * 2;
  return new Table({
    width: { size: textWidth, type: WidthType.DXA },
    columnWidths: columns,
    layout: TableLayoutType.FIXED,
    rows: rows.map(
      (row, index) =>
        new TableRow({
          tableHeader: index === 0,
          cantSplit: index === 0,
          children: Array.from({ length: width }, (_, column) => {
            const cell = row.content?.[column];
            const header = cell?.type === 'tableHeader';
            return new TableCell({
              width: { size: columns[column], type: WidthType.DXA },
              shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: 'EEEEEE' } : undefined,
              margins: { left: 100, right: 100, ...(layout.id === 'tor' ? { top: 60, bottom: 60 } : {}) },
              children: (cell?.content?.length ? cell.content : [{ type: 'paragraph' }]).map(
                p =>
                  new Paragraph({
                    alignment: numeric[column] ? AlignmentType.RIGHT : AlignmentType.LEFT,
                    widowControl: true,
                    children: runs(p, size, header, font, false, layout.presentation.thaiBreaks),
                  }),
              ),
            });
          }),
        }),
    ),
  });
}

function docxBlocks(
  node: DraftNode,
  layout: WordLayout,
  role: LayoutRole | 'quote' | 'letter-head' = 'body',
  numbering?: { reference: string; level: number },
  depth = 0,
  firstPageSpace = false,
  breakBefore = false,
  extraBefore = 0,
): (Paragraph | Table)[] {
  if (node.type === 'pageBreak') return [new Paragraph({ pageBreakBefore: true, spacing: { line: 20, lineRule: LineRuleType.EXACT } })];
  if (node.type === 'image') {
    const image = layout.images.get(node.attrs!.assetId!);
    if (!image) throw new Error('DOCUMENT_IMAGE_NOT_FOUND');
    const preset = wordPreset(layout);
    const maxHeight = (16838 - Math.round((preset.margins.top + preset.margins.bottom) * CM)) / 15 - 72;
    const width = Math.min(((node.attrs?.widthCm || 12) * 96) / 2.54, wordWidth(layout) / 15, (maxHeight * image.width) / image.height);
    return [
      new Paragraph({
        pageBreakBefore: breakBefore,
        alignment: AlignmentType.CENTER,
        keepNext: true,
        children: [
          new ImageRun({
            type: 'png',
            data: image.bytes,
            transformation: { width, height: (width * image.height) / image.width },
            altText: { name: 'Document image', title: node.attrs?.alt || '', description: node.attrs?.alt || '' },
          }),
        ],
      }),
    ];
  }
  if (node.type === 'blockquote')
    return (node.content || []).flatMap((child, index) =>
      docxBlocks(child, layout, 'quote', undefined, depth, false, breakBefore && index === 0),
    );
  if (node.type === 'table')
    return [
      ...(breakBefore
        ? [
            new Paragraph({
              pageBreakBefore: true,
              keepNext: true,
              spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT },
            }),
          ]
        : []),
      docxTable(node, layout),
      new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT }, children: [] }),
    ];
  if (['paragraph', 'heading', 'title', 'caption'].includes(node.type)) {
    const title = node.type === 'title' || role === 'title';
    const caption = node.type === 'caption';
    const level = node.attrs?.level || 1;
    const points = wordPreset(layout).points;
    const size = title
      ? layout.id === 'memo'
        ? 58
        : layout.id === 'tor'
          ? (points + TOR_LAYOUT.titleExtra) * 2
          : 44
      : caption
        ? (points - 2) * 2
        : node.type === 'heading'
          ? (layout.id === 'tor' ? points : points + [4, 2, 0][level - 1]) * 2
          : points * 2;
    const band = Math.floor(wordWidth(layout) / 2);
    const centered = title || caption || ['subject', 'signature', 'date'].includes(role);
    const body = role === 'body' && node.type === 'paragraph' && !depth;
    const numbered = layout.id === 'tor' ? torNumberedBlock(node) : undefined;
    return [
      new Paragraph({
        pageBreakBefore: breakBefore,
        ...(title
          ? { heading: HeadingLevel.TITLE }
          : node.type === 'heading'
            ? { heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][level - 1] }
            : caption
              ? { style: 'Caption' }
              : {}),
        numbering,
        alignment:
          centered || centerFrontMatter(layout, role)
            ? AlignmentType.CENTER
            : (layout.id === 'tor' || layout.presentation.invitation) && body
              ? AlignmentType.JUSTIFIED
              : AlignmentType.LEFT,
        indent: numbering
          ? undefined
          : numbered
            ? { left: Math.round((numbered.leftCm + numbered.widthCm) * CM), hanging: Math.round(numbered.widthCm * CM) }
            : role === 'quote'
              ? { left: 720, right: 720 }
              : depth
                ? { left: 360 * depth }
                : ['signature', 'sender'].includes(role)
                  ? { left: band }
                  : role === 'letter-head'
                    ? { left: band, hanging: band }
                    : body
                      ? { firstLine: Math.round(wordPreset(layout).indent * CM) }
                      : undefined,
        tabStops: numbered
          ? [{ type: TabStopType.LEFT, position: Math.round((numbered.leftCm + numbered.widthCm) * CM) }]
          : role === 'memo-reference' || role === 'letter-head'
            ? [{ type: TabStopType.LEFT, position: band }]
            : undefined,
        keepNext:
          title ||
          node.type === 'heading' ||
          ['subject', 'front', 'sender', 'date', 'memo-reference', 'letter-head'].includes(role) ||
          (role === 'signature' && /^(?:\(|ขอแสดงความนับถือ)/.test(documentText(node))),
        keepLines: title || caption || node.type === 'heading' || role === 'signature',
        widowControl: true,
        spacing: {
          ...(layout.presentation.invitation
            ? { line: Math.round(INVITATION_LAYOUT.points * INVITATION_LAYOUT.line * 20), lineRule: LineRuleType.EXACT }
            : {}),
          before: firstPageSpace
            ? Math.round(0.5 * CM)
            : extraBefore
              ? Math.round(extraBefore * 20)
              : layout.id === 'tor' && title
                ? 0
                : node.type === 'heading' && layout.id === 'tor'
                  ? 160
                  : title || node.type === 'heading'
                    ? 120
                    : 0,
          after:
            layout.id === 'tor' && title
              ? 120
              : role === 'subject'
                ? 60
                : node.type === 'paragraph'
                  ? role === 'body' && documentText(node).trim()
                    ? wordPreset(layout).after * 20
                    : 0
                  : 60,
        },
        children: numbered
          ? [
              ...runs(numbered.prefix, size, node.type === 'heading', layout.font, false, layout.presentation.thaiBreaks),
              new TextRun({ children: [new Tab()] }),
              ...runs(numbered.body, size, node.type === 'heading', layout.font, false, layout.presentation.thaiBreaks),
            ]
          : runs(
              node,
              size,
              title || node.type === 'heading' || role === 'subject',
              layout.font,
              role === 'memo-reference',
              layout.presentation.thaiBreaks,
              layout.id === 'memo' && (role === 'memo-reference' || role === 'field'),
            ),
      }),
    ];
  }
  if (node.type === 'bulletList' || node.type === 'orderedList')
    return (node.content || []).flatMap((item, itemIndex) =>
      (item.content || []).flatMap((child, index) =>
        docxBlocks(
          child,
          layout,
          'body',
          index === 0 && child.type === 'paragraph' ? { reference: layout.lists.get(node)!, level: Math.min(depth, 8) } : undefined,
          depth + 1,
          false,
          breakBefore && itemIndex === 0 && index === 0,
        ),
      ),
    );
  return (node.content || []).flatMap(child => docxBlocks(child, layout, 'body', undefined, depth));
}

function invitationWordBlocks(document: DraftNode, layout: WordLayout): (Paragraph | Table)[] {
  const parts = invitationParts(document);
  const borders = Object.fromEntries(
    ['top', 'bottom', 'left', 'right'].map(key => [key, { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }]),
  );
  const cell = (width: number, children: (Paragraph | Table)[], left = 0) =>
    new TableCell({
      width: { size: Math.round(width * CM), type: WidthType.DXA },
      borders,
      verticalAlign: VerticalAlign.TOP,
      margins: { top: 0, bottom: 0, left: Math.round(left * CM), right: 0 },
      children: children.length ? children : [new Paragraph({ children: [] })],
    });
  const table = (widths: number[], cells: TableCell[]) =>
    new Table({
      width: { size: wordWidth(layout), type: WidthType.DXA },
      columnWidths: widths.map(w => Math.round(w * CM)),
      layout: TableLayoutType.FIXED,
      borders,
      rows: [new TableRow({ cantSplit: true, children: cells })],
    });
  const plain = (nodes: DraftNode[]) => nodes.flatMap(n => docxBlocks(n, layout, 'field'));
  const headerText = (nodes: DraftNode[]) =>
    nodes.length
      ? [
          new Paragraph({ spacing: { before: 0, after: 0, line: Math.round(1.8 * CM), lineRule: LineRuleType.EXACT }, children: [] }),
          ...plain(nodes),
        ]
      : [];
  const header = table(
    [...INVITATION_LAYOUT.headerColumnsCm],
    [
      cell(6, headerText(parts.number)),
      cell(3, [
        new Paragraph({
          spacing: { before: 0, after: 0 },
          children: [
            new ImageRun({
              type: 'png',
              data: GARUDA_PNG,
              transformation: { width: (3 * 96) / 2.54, height: (3 * 96) / 2.54 },
              altText: { name: 'Garuda', title: 'ตราครุฑ', description: 'Garuda' },
            }),
          ],
        }),
      ]),
      cell(7, headerText(parts.sender), 1),
    ],
  );
  const body: (Paragraph | Table)[] = [header];
  body.push(
    ...parts.date.map(
      n =>
        new Paragraph({
          children: runs(n, 32, false, layout.font, false, layout.presentation.thaiBreaks),
          alignment: AlignmentType.CENTER,
          keepNext: true,
          keepLines: true,
          spacing: {
            before: Math.round(INVITATION_LAYOUT.dateBeforeCm * CM),
            after: Math.round(INVITATION_LAYOUT.dateAfterCm * CM),
            line: Math.round(INVITATION_LAYOUT.points * INVITATION_LAYOUT.line * 20),
            lineRule: LineRuleType.EXACT,
          },
        }),
    ),
  );
  for (const n of parts.body) {
    if (n.type === 'paragraph' && /^(?:เรื่อง|เรียน|อ้างถึง|สิ่งที่ส่งมาด้วย)(?:\s|$)/.test(documentText(n).trim())) {
      body.push(
        new Paragraph({
          children: runs(n, 32, false, layout.font, false, layout.presentation.thaiBreaks),
          ...(/^(?:เรื่อง|เรียน)(?:\s|$)/.test(documentText(n).trim())
            ? { indent: { left: Math.round(INVITATION_LAYOUT.frontHangCm * CM), hanging: Math.round(INVITATION_LAYOUT.frontHangCm * CM) } }
            : {}),
          keepLines: true,
          keepNext: true,
          spacing: {
            before: 0,
            after: 160,
            line: Math.round(INVITATION_LAYOUT.points * INVITATION_LAYOUT.line * 20),
            lineRule: LineRuleType.EXACT,
          },
        }),
      );
    } else body.push(...docxBlocks(n, layout, 'body'));
  }
  for (const [index, n] of parts.signature.entries()) {
    if (n.type !== 'paragraph') {
      body.push(...docxBlocks(n, layout, 'signature'));
      continue;
    }
    body.push(
      new Paragraph({
        children: runs(n, 32, false, layout.font, false, layout.presentation.thaiBreaks),
        alignment: AlignmentType.CENTER,
        indent: { left: 4 * CM, right: 2 * CM },
        keepLines: true,
        keepNext: index < parts.signature.length - 1,
        spacing: {
          before: 0,
          after: index === 0 ? Math.round(INVITATION_LAYOUT.signatureGapCm * CM) : 0,
          line: Math.round(INVITATION_LAYOUT.points * INVITATION_LAYOUT.line * 20),
          lineRule: LineRuleType.EXACT,
        },
      }),
    );
  }
  const qrs = layout.qrs || [];
  if (parts.contact.length || qrs.length) {
    body.push(new Paragraph({ spacing: { before: 100, after: 0 }, keepNext: true, children: [] }));
    const contactWidth = 16 - 3 * qrs.length;
    body.push(
      table(
        [contactWidth, ...qrs.map(() => 3)],
        [
          cell(contactWidth, plain(parts.contact)),
          ...qrs.map(q =>
            cell(3, [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                keepNext: true,
                spacing: { before: 0, after: 0 },
                children: [
                  new ImageRun({
                    type: 'png',
                    data: q.bytes,
                    transformation: { width: (INVITATION_LAYOUT.qrCm * 96) / 2.54, height: (INVITATION_LAYOUT.qrCm * 96) / 2.54 },
                    altText: { name: 'QR', title: q.label, description: q.label },
                  }),
                ],
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                keepLines: true,
                spacing: { before: 0, after: 0 },
                children: [
                  new TextRun({ text: q.label, font: layout.font, size: 24, sizeComplexScript: 24, language: THAI_DOCUMENT_LANGUAGE }),
                ],
              }),
            ]),
          ),
        ],
      ),
    );
  }
  return body;
}

function docx(document: DraftNode, layout: WordLayout) {
  const numberingConfig: INumberingOptions['config'][number][] = [];
  const collectLists = (node: DraftNode) => {
    if (['bulletList', 'orderedList'].includes(node.type)) {
      const reference = 'step-list-' + layout.lists.size;
      layout.lists.set(node, reference);
      numberingConfig.push({
        reference,
        levels: Array.from({ length: 9 }, (_, level) => ({
          level,
          format: node.type === 'bulletList' ? LevelFormat.BULLET : LevelFormat.DECIMAL,
          text: node.type === 'bulletList' ? ['•', '◦', '▪'][level % 3] : '%' + (level + 1) + '.',
          start: node.attrs?.start || 1,
          style: {
            run: { font: layout.font, size: wordPreset(layout).points * 2, sizeComplexScript: wordPreset(layout).points * 2 },
            paragraph: { indent: { left: 360 * (level + 1), hanging: 180 } },
          },
        })),
      });
    }
    (node.content || []).forEach(collectLists);
  };
  collectLists(document);
  const preset = wordPreset(layout);
  const heading = (size: number) => ({
    run: {
      font: layout.font,
      size,
      sizeComplexScript: size,
      bold: true,
      boldComplexScript: true,
      language: THAI_DOCUMENT_LANGUAGE,
      color: '000000',
    },
    paragraph: { spacing: { before: 120, after: 60 }, keepNext: true, keepLines: true },
  });
  const roles = documentLayoutRoles(document, layout.id);
  const spacing = sarabanSpacing(document, layout.id);
  const blocks = document.content || [];
  const title =
    layout.id === 'memo' && layout.garudaHeightCm && ['heading', 'title'].includes(blocks[0]?.type || '') ? blocks[0] : undefined;
  const appearance = layout.presentation;
  const saraban = appearance.pageNumber === 'saraban' && !appearance.invitation;
  const pageAt = (position: 'header' | 'footer') =>
    saraban ? position === 'header' : appearance.pageNumber !== 'none' && appearance.pageNumberPosition.startsWith(position);
  const textLine = (text: string) =>
    new Paragraph({
      spacing: { before: 0, after: 0 },
      children: runs(
        { type: 'paragraph', content: [{ type: 'text', text }] },
        layout.id === 'tor' ? 24 : 28,
        false,
        layout.font,
        false,
        appearance.thaiBreaks,
      ),
    });
  const numberLine = () =>
    new Paragraph({
      alignment: saraban || appearance.pageNumberPosition === 'footer-center' ? AlignmentType.CENTER : AlignmentType.RIGHT,
      spacing: { before: 0, after: 0 },
      children: [
        new TextRun({
          font: layout.font,
          size: layout.id === 'tor' ? 24 : saraban ? preset.points * 2 : 28,
          sizeComplexScript: layout.id === 'tor' ? 24 : saraban ? preset.points * 2 : 28,
          language: THAI_DOCUMENT_LANGUAGE,
          bold: false,
          boldComplexScript: false,
          italics: false,
          italicsComplexScript: false,
          children: saraban
            ? ['- ', PageNumber.CURRENT, ' -']
            : appearance.pageNumber === 'thai'
              ? ['หน้า ', PageNumber.CURRENT]
              : [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES],
        }),
      ],
    });
  const headerLines = () => [
    ...(appearance.headerText ? [textLine(appearance.headerText)] : []),
    ...(pageAt('header') ? [numberLine()] : []),
  ];
  const footer = () =>
    new Footer({
      children: [
        ...(layout.id === 'tor'
          ? [
              new Paragraph({
                border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC', space: 2 } },
                spacing: { before: 0, after: 0 },
                children: runs(
                  { type: 'paragraph', content: [{ type: 'text', text: torFooterText(document, appearance) }] },
                  24,
                  false,
                  layout.font,
                  false,
                  appearance.thaiBreaks,
                ),
              }),
            ]
          : appearance.footerText
            ? [textLine(appearance.footerText)]
            : []),
        ...(pageAt('footer') ? [numberLine()] : []),
      ],
    });
  const hasHeader = layout.id === 'tor' || Boolean(appearance.headerText || pageAt('header'));
  const hasFooter = layout.id === 'tor' || Boolean(appearance.footerText || pageAt('footer'));
  // Page 1 never carries the saraban page number; with a Garuda it carries the emblem instead.
  const firstHeaderText = () => (appearance.headerText ? [textLine(appearance.headerText)] : []);
  const garudaHeader =
    layout.garudaHeightCm && !layout.presentation.invitation
      ? new Header({
          children: [
            new Paragraph({
              alignment: layout.id === 'memo' ? AlignmentType.LEFT : AlignmentType.CENTER,
              indent: { left: layout.id === 'letter' ? -CM : 0, firstLine: 0 },
              spacing: { before: 0, after: 0 },
              tabStops: layout.id === 'memo' ? [{ type: TabStopType.CENTER, position: 8 * CM }] : undefined,
              children: [
                new ImageRun({
                  type: 'png',
                  data: GARUDA_PNG,
                  transformation: { width: (layout.garudaHeightCm * 96) / 2.54, height: (layout.garudaHeightCm * 96) / 2.54 },
                  altText: { name: 'Garuda', title: 'ตราครุฑ', description: 'Garuda' },
                }),
                ...(title
                  ? [new TextRun({ children: [new Tab()] }), ...runs(title, 58, true, layout.font, false, appearance.thaiBreaks)]
                  : []),
              ],
            }),
            ...(saraban ? firstHeaderText() : headerLines()),
          ],
        })
      : undefined;
  const firstHeader = garudaHeader || (saraban ? new Header({ children: firstHeaderText() }) : undefined);
  const tocBlocks = appearance.toc
    ? [
        new Paragraph({
          style: 'TOCHeading',
          children: runs({ type: 'paragraph', content: [{ type: 'text', text: 'สารบัญ' }] }, (preset.points + 4) * 2, true, layout.font),
        }),
        new TableOfContents('Table of contents', { headingStyleRange: '1-3', hyperlink: true }),
      ]
    : [];
  const body: (Paragraph | Table | TableOfContents)[] = [];
  let breakBefore = false;
  if (layout.id === 'letter' && appearance.invitation) body.push(...invitationWordBlocks(document, layout));
  else {
    const head = letterHeadRow(blocks, roles, layout.id, appearance.invitation);
    for (const [index, node] of blocks.entries()) {
      if (node === title || (head >= 0 && index === head + 1)) continue;
      if (node.type === 'pageBreak') {
        if (breakBefore) body.push(...docxBlocks(node, layout));
        breakBefore = true;
        continue;
      }
      body.push(
        ...docxBlocks(
          index === head ? letterHeadNode(node, blocks[index + 1]) : node,
          layout,
          index === head ? 'letter-head' : roles[index],
          undefined,
          0,
          Boolean(garudaHeader && index === (title ? 1 : 0)),
          breakBefore,
          spacing[index],
        ),
      );
      breakBefore = false;
    }
  }
  if (breakBefore) body.push(...docxBlocks({ type: 'pageBreak' }, layout));
  const tocIndex = !title && blocks[0]?.type === 'title' ? 1 : 0;
  body.splice(tocIndex, 0, ...tocBlocks);
  return new Document({
    compatibility: { doNotExpandShiftReturn: true },
    features: { updateFields: true },
    numbering: { config: numberingConfig },
    styles: {
      paragraphStyles: [
        {
          id: 'Caption',
          name: 'Caption',
          basedOn: 'Normal',
          run: {
            font: layout.font,
            size: (preset.points - 2) * 2,
            sizeComplexScript: (preset.points - 2) * 2,
            language: THAI_DOCUMENT_LANGUAGE,
          },
          paragraph: { outlineLevel: 9 },
        },
        {
          id: 'TOCHeading',
          name: 'TOC Heading',
          basedOn: 'Normal',
          run: heading((preset.points + 4) * 2).run,
          paragraph: { outlineLevel: 9, keepNext: true },
        },
        ...[1, 2, 3].map(level => ({
          id: 'TOC' + level,
          name: 'toc ' + level,
          basedOn: 'Normal',
          run: { font: layout.font, size: preset.points * 2, sizeComplexScript: preset.points * 2, language: THAI_DOCUMENT_LANGUAGE },
          paragraph: { outlineLevel: 9, indent: { left: (level - 1) * 360 }, spacing: { before: 0, after: 0 } },
        })),
      ],
      default: {
        document: {
          run: { font: layout.font, size: preset.points * 2, sizeComplexScript: preset.points * 2, language: THAI_DOCUMENT_LANGUAGE },
          paragraph: { spacing: { before: 0, after: 0, line: Math.round(preset.line * 240), lineRule: LineRuleType.AUTO } },
        },
        heading1: heading((preset.points + (layout.id === 'tor' ? 0 : 4)) * 2),
        heading2: heading((preset.points + (layout.id === 'tor' ? 0 : 2)) * 2),
        heading3: heading(preset.points * 2),
        title: {
          ...heading(layout.id === 'tor' ? (preset.points + TOR_LAYOUT.titleExtra) * 2 : 44),
          paragraph: { ...heading(44).paragraph, outlineLevel: 9 },
        },
      },
    },
    sections: [
      {
        properties: {
          ...(firstHeader ? { titlePage: true } : {}),
          page: {
            size: { width: 11906, height: 16838 },
            margin: {
              top: Math.round(preset.margins.top * CM),
              bottom: Math.round(preset.margins.bottom * CM),
              left: Math.round(preset.margins.left * CM),
              right: Math.round(preset.margins.right * CM),
              ...(firstHeader || hasHeader ? { header: Math.round((garudaHeader ? 1.5 : 1) * CM) } : {}),
              ...(layout.id === 'tor'
                ? { header: Math.round(TOR_LAYOUT.headerCm * CM), footer: Math.round(TOR_LAYOUT.footerCm * CM) }
                : {}),
            },
            pageNumbers: {
              formatType: saraban || appearance.pageNumber === 'thai' ? NumberFormat.THAI_NUMBERS : NumberFormat.DECIMAL,
            },
          },
        },
        ...(firstHeader || hasHeader
          ? {
              headers: {
                ...(hasHeader
                  ? {
                      default:
                        layout.id === 'tor'
                          ? torWordHeader(layout.font, wordWidth(layout), headerLines())
                          : new Header({ children: headerLines() }),
                    }
                  : {}),
                ...(firstHeader ? { first: firstHeader } : {}),
              },
            }
          : {}),
        ...(hasFooter ? { footers: { default: footer(), ...(firstHeader ? { first: footer() } : {}) } } : {}),
        children: body,
      },
    ],
  });
}

export type ExportDocumentOptions = {
  documentTool?: unknown;
  font?: unknown;
  garuda?: unknown;
  presentation?: unknown;
  /** Reads a bundled font file named in its manifest; without it, fonts are not embedded. */
  fonts?: FontFile;
};

// Web: drafts are Markdown, read the same way Desktop reads a model's draft.
// TOR clauses typed on the next line of a paragraph are laid out as their own numbered paragraphs, as on Desktop.
const draftDocument = (markdown: string, documentTool?: unknown) => {
  if (markdown.length > 200000) throw new Error('DOCUMENT_TOO_LARGE');
  const content = validateDocument(markdownDocument(markdown));
  return documentTool === 'tor' ? torClauseDocument(content) : content;
};

/** Word bytes for a draft, with Desktop's layout, presentation and font embedding. */
export async function exportDocx(markdown: string, options: ExportDocumentOptions = {}) {
  const content = draftDocument(markdown, options.documentTool);
  const presentation = resolvePresentation(options.presentation, typeof options.documentTool === 'string' ? options.documentTool : false);
  const layout = resolveDocumentLayout(options.documentTool, options.font, options.garuda);
  const bytes = new Uint8Array(
    await Packer.toArrayBuffer(docx(content, { ...layout, presentation, images: new Map(), lists: new Map() })),
  );
  const result =
    presentation.embedFonts && options.fonts
      ? await embedDocumentFonts(bytes, options.fonts)
      : { bytes, embedding: { status: 'disabled' as const, families: [] as string[] } };
  return {
    bytes: result.bytes,
    layout,
    fontEmbedding: result.embedding,
    fieldsNeedUpdate: presentation.toc || presentation.pageNumber !== 'none',
  };
}

/** The A4 page Desktop prints to PDF; the web prints it and shows it as the page preview. */
export function exportPdfHtml(markdown: string, options: ExportDocumentOptions & { fontFaces?: string } = {}) {
  const layout = resolveDocumentLayout(options.documentTool, options.font, options.garuda);
  return pdfHtml(
    draftDocument(markdown, options.documentTool),
    layout,
    new Map(),
    resolvePresentation(options.presentation, layout.id || false),
    [],
    options.fontFaces,
  );
}
