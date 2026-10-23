import { saveBlob } from './host.ts';
import { LIMITS } from '../../packages/harness-core/src/index.ts';
export async function extractText(file: File): Promise<string> {
  if (file.size > LIMITS.uploadBytes) throw new Error('DOCUMENT_TOO_LARGE');
  if (file.type.startsWith('text/')) return bounded(await file.text());
  if (file.type.startsWith('image/')) return '';
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (file.type === 'application/pdf') {
    const pdf = await import('pdfjs-dist');
    pdf.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;
    const task = pdf.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    const document = await task.promise;
    try {
      if (document.numPages > 30) throw new Error('DOCUMENT_PAGE_LIMIT');
      let text = '';
      for (let n = 1; n <= document.numPages; n++) {
        const page = await document.getPage(n),
          content = await page.getTextContent();
        text +=
          `\n[หน้า ${n}]\n` +
          content.items
            .filter((x) => 'str' in x)
            .map((x) => ('str' in x ? x.str + ('hasEOL' in x && x.hasEOL ? '\n' : ' ') : ''))
            .join('');
        bounded(text);
      }
      return text.replace(/\[หน้า \d+\]/g, '').trim() ? bounded(text) : '';
    } finally {
      await task.destroy();
    }
  }
  if (['docx', 'xlsx', 'pptx'].includes(extension || '')) {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entries = Object.values(zip.files);
    if (entries.length > 2000) throw new Error('FILE_INVALID');
    // Central directory sizes are checked before decompressing any Office content.
    const total = entries.reduce(
      (n, f) =>
        n + Number((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize || 0),
      0,
    );
    if (total > 30 * 1024 * 1024) throw new Error('DOCUMENT_TOO_LARGE');
    const targets = entries
      .filter((f) =>
        extension === 'docx'
          ? f.name === 'word/document.xml'
          : extension === 'pptx'
            ? /^ppt\/slides\/slide\d+\.xml$/.test(f.name)
            : /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name),
      )
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const parser = new DOMParser();
    const nodes = (parent: Document | Element, name: string) => [...parent.getElementsByTagNameNS('*', name)];
    const content = (parent: Document | Element) =>
      nodes(parent, 't')
        .map((n) => n.textContent || '')
        .join('');
    const xml = async (name: string) => {
      const value = await zip.file(name)?.async('string');
      if (!value) throw new Error('FILE_INVALID');
      if (value.length > 8 * 1024 * 1024) throw new Error('DOCUMENT_TOO_LARGE');
      const parsed = parser.parseFromString(value, 'application/xml');
      if (parsed.querySelector('parsererror')) throw new Error('FILE_INVALID');
      return parsed;
    };
    const shared =
      extension === 'xlsx' && zip.file('xl/sharedStrings.xml')
        ? nodes(await xml('xl/sharedStrings.xml'), 'si').map(content)
        : [];
    let text = '';
    for (const entry of targets) {
      const doc = await xml(entry.name);
      let body = '';
      if (extension === 'xlsx') {
        body = nodes(doc, 'row')
          .map((row) =>
            nodes(row, 'c')
              .map((cell) => {
                const raw = nodes(cell, 'v')[0]?.textContent || '',
                  kind = cell.getAttribute('t');
                const value =
                  kind === 's' ? shared[Number(raw)] || '' : kind === 'inlineStr' ? content(cell) : raw;
                return cell.getAttribute('r') + ': ' + value;
              })
              .join(' | '),
          )
          .join('\n');
      } else if (extension === 'docx') {
        const root = nodes(doc, 'body')[0];
        if (!root) throw new Error('FILE_INVALID');
        body = [...root.children]
          .map((part) =>
            part.localName === 'tbl'
              ? nodes(part, 'tr')
                  .map((row) =>
                    [...row.children]
                      .filter((c) => c.localName === 'tc')
                      .map(content)
                      .join(' | '),
                  )
                  .join('\n')
              : content(part),
          )
          .join('\n');
      } else body = nodes(doc, 'p').map(content).join('\n');
      text += '\n[' + entry.name + ']\n' + body;
      bounded(text);
    }
    return text;
  }
  return '';
}
function bounded(text: string) {
  if (text.length > 200000) throw new Error('DOCUMENT_TOO_LARGE');
  return text;
}
export async function exportWord(
  text: string,
  name: string,
  preset: 'saraban' | 'report' | 'book' = 'report',
) {
  const { DOCUMENT_PRESETS } =
    await import('../../packages/harness-core/vendor/desktop/document-presentation.ts');
  const format = DOCUMENT_PRESETS[preset];
  if (!format || text.length > 200000) throw new Error('DOCUMENT_TOO_LARGE');
  const {
    Document,
    Paragraph,
    Packer,
    TextRun,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    Footer,
    PageNumber,
    AlignmentType,
  } = await import('docx');
  const runs = (line: string) =>
    line
      .split(/(\*\*[^*]+\*\*)/g)
      .filter(Boolean)
      .map(
        (part) =>
          new TextRun({
            text: part.replace(/^\*\*|\*\*$/g, ''),
            bold: part.startsWith('**'),
            font: 'TH Sarabun New',
            size: format.points * 2,
          }),
      );
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())
      .slice(0, 20);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
      const rows = [cells(line)];
      i++;
      while (lines[i + 1]?.trim().startsWith('|')) rows.push(cells(lines[++i]));
      children.push(
        new Table({
          rows: rows.map(
            (row, index) =>
              new TableRow({
                tableHeader: index === 0,
                children: row.map(
                  (cell) => new TableCell({ children: [new Paragraph({ children: runs(cell) })] }),
                ),
              }),
          ),
        }),
      );
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*]\s+/.test(line);
    children.push(
      new Paragraph({
        children: runs(heading ? heading[2] : bullet ? line.replace(/^\s*[-*]\s+/, '') : line),
        ...(heading
          ? {
              heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][
                heading[1].length - 1
              ],
            }
          : {}),
        ...(bullet ? { bullet: { level: 0 } } : {}),
        spacing: { line: Math.round(format.line * 240), after: format.after * 20 },
      }),
    );
  }
  const cm = (value: number) => Math.round(value * 567);
  const document = new Document({
    styles: { default: { document: { run: { font: 'TH Sarabun New', size: format.points * 2 } } } },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: Object.fromEntries(
              Object.entries(format.margins).map(([key, value]) => [key, cm(value)]),
            ),
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES] })],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  saveBlob(await Packer.toBlob(document), name.replace(/\.[^.]+$/, '') + '.docx');
}
