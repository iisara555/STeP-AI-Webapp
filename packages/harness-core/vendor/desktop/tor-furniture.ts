import {
  BorderStyle,
  Header,
  ImageRun,
  LineRuleType,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';
import type { DraftNode } from './draft.ts';
import type { DocumentPresentation } from './document-presentation.ts';
import { TOR_LAYOUT, TOR_ORGANIZATION, torFooterText } from './tor-layout.ts';
import { STEP_TOR_LOGO, STEP_TOR_LOGO_URI } from './step-tor-logo.ts';

const CM = 567;
const escape = (value: string) =>
  value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function torWordHeader(font: string, width: number, extra: Paragraph[]) {
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const paragraph = { spacing: { before: 0, after: 0 } };
  return new Header({
    children: [
      new Table({
        width: { size: width, type: WidthType.DXA },
        layout: TableLayoutType.FIXED,
        columnWidths: [Math.round(3.4 * CM), width - Math.round(3.4 * CM)],
        borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
        rows: [
          new TableRow({
            children: [
              new TableCell({
                margins: { top: 0, bottom: 0, left: 0, right: 0 },
                verticalAlign: VerticalAlign.CENTER,
                children: [
                  new Paragraph({
                    ...paragraph,
                    children: [
                      new ImageRun({
                        type: 'png',
                        data: STEP_TOR_LOGO,
                        transformation: { width: (TOR_LAYOUT.logoWidthCm * 96) / 2.54, height: (TOR_LAYOUT.logoHeightCm * 96) / 2.54 },
                        altText: { name: 'STeP', title: 'STeP', description: 'Science and Technology Park Chiang Mai University' },
                      }),
                    ],
                  }),
                ],
              }),
              new TableCell({
                margins: { top: 0, bottom: 0, left: 0, right: 0 },
                verticalAlign: VerticalAlign.CENTER,
                children: [
                  new Paragraph({
                    ...paragraph,
                    children: [
                      new TextRun({
                        text: TOR_ORGANIZATION,
                        font,
                        size: 28,
                        sizeComplexScript: 28,
                        language: { value: 'th-TH', eastAsia: 'th-TH' },
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      new Paragraph({
        spacing: { before: 40, after: 0, line: 20, lineRule: LineRuleType.EXACT },
        border: { bottom: { style: BorderStyle.DOUBLE, size: 4, color: 'BBBBBB', space: 1 } },
      }),
      ...extra,
    ],
  });
}

/** Native print templates and page counters repeat without scripts or external resources. */
export function torPdfFurniture(document: DraftNode, font: string, presentation: DocumentPresentation) {
  const box =
    presentation.pageNumberPosition === 'header-right'
      ? 'top-right'
      : presentation.pageNumberPosition === 'footer-center'
        ? 'bottom-center'
        : 'bottom-right';
  const counter = presentation.pageNumber === 'thai' ? '"หน้า " counter(page, thai)' : 'counter(page) " / " counter(pages)';
  const css = `
    @page { ${presentation.pageNumber === 'none' ? '' : `@${box} { content:${counter};font-family:"${font}";font-size:12pt;color:#777; }`} }
  `;
  const wrapper = `width:100%;margin:0 2cm 0 3cm;font-family:'${font}','Leelawadee UI','Thonburi',sans-serif;box-sizing:border-box;`;
  return {
    css,
    headerTemplate: `<div class="tor-letterhead" style="${wrapper}margin-top:.3cm;"><div style="display:flex;align-items:center;gap:.4cm;border-bottom:3px double #bbb;padding-bottom:.12cm;font-size:14pt;line-height:1;"><img alt="STeP" src="${STEP_TOR_LOGO_URI}" style="width:${TOR_LAYOUT.logoWidthCm}cm;height:${TOR_LAYOUT.logoHeightCm}cm;"><span>${escape(TOR_ORGANIZATION)}${presentation.headerText ? `<br><span style="font-size:12pt">${escape(presentation.headerText)}</span>` : ''}</span></div></div>`,
    footerTemplate: `<div class="tor-footer" style="${wrapper}border-top:.5pt solid #ccc;padding-top:2pt;padding-bottom:.3cm;font-size:12pt;line-height:1;color:#888;"><span>${escape(torFooterText(document, presentation))}</span></div>`,
  };
}
