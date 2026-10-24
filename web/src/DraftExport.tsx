import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, SlidersHorizontal } from './icons.tsx';
import { saveBlob } from './host.ts';
import {
  exportDocx,
  escapeHtml,
  exportPdfHtml,
} from '../../packages/harness-core/vendor/desktop/document-export.ts';
import {
  DOCUMENT_FONTS,
  probeDocumentFont,
  resolveDocumentLayout,
} from '../../packages/harness-core/vendor/desktop/document-layout.ts';
import {
  resolvePresentation,
  type DocumentPresentation,
} from '../../packages/harness-core/vendor/desktop/document-presentation.ts';
import type { FontEmbedding } from '../../packages/harness-core/vendor/desktop/document-fonts.ts';
import type { DocumentToolId } from '../../packages/harness-core/vendor/desktop/document-tools.ts';

// The same pinned TH Sarabun files Desktop bundles, served by this site; the exporter checks their hashes.
const FONT_FILES = /^[a-z0-9-]+\.(?:ttf|json)$/i;
async function fontFile(file: string) {
  if (!FONT_FILES.test(file)) throw new Error('DOCUMENT_FONT_UNAVAILABLE');
  const response = await fetch('/document-fonts/' + file);
  if (!response.ok) throw new Error('DOCUMENT_FONT_UNAVAILABLE');
  return new Uint8Array(await response.arrayBuffer());
}
const FACES: [string, string][] = [
  ['TH Sarabun New', 'sarabun-new'],
  ['TH SarabunPSK', 'sarabun-psk'],
];
/** Installed copies first; otherwise the bundled files, so the page and PDF look the same on every device. */
const fontFaces = () =>
  FACES.flatMap(([family, file]) =>
    (
      [
        ['regular', 400, 'normal'],
        ['bold', 700, 'normal'],
        ['italic', 400, 'italic'],
        ['boldItalic', 700, 'italic'],
      ] as const
    ).map(
      ([face, weight, style]) =>
        `@font-face{font-family:"${family}";font-weight:${weight};font-style:${style};src:local("${family}${
          face === 'regular' ? '' : face === 'bold' ? ' Bold' : face === 'italic' ? ' Italic' : ' Bold Italic'
        }"),url("${location.origin}/document-fonts/${file}-${face}.ttf")}`,
    ),
  ).join('');
// On screen the page is drawn as an A4 sheet; print uses the page's own @page rules.
const SCREEN_PAGE = (garuda: boolean) =>
  `@media screen{html{background:#e7e5e0}body{width:21cm;min-height:29.7cm;margin:12px auto;padding:${
    garuda ? 1.5 : 2.5
  }cm 2cm 2cm 3cm;box-sizing:border-box;background:#fff;color:#000;box-shadow:0 1px 4px rgba(0,0,0,.25)}}`;

export type ExportChoice = { font: string; garuda: 'auto' | 'none' };
const layoutOptions = (documentTool: DocumentToolId | undefined, choice: ExportChoice) => ({
  documentTool,
  ...(choice.font !== 'auto' ? { font: choice.font } : {}),
  garuda: choice.garuda,
});
const fileName = (title: string, extension: string) =>
  (title
    .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
    .trim()
    .slice(0, 120) || 'ร่างเอกสาร') +
  '.' +
  extension;

/** The draft as its A4 page: Garuda, letterhead, roles and font as the Word and PDF files lay them out. */
export function DraftPage({
  draft,
  documentTool,
  choice,
}: {
  draft: string;
  documentTool?: DocumentToolId;
  choice: ExportChoice;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const layout = resolveDocumentLayout(
    documentTool,
    choice.font === 'auto' ? undefined : choice.font,
    choice.garuda,
  );
  let html = '';
  try {
    html = exportPdfHtml(draft, { ...layoutOptions(documentTool, choice), fontFaces: fontFaces() }).replace(
      '</style>',
      SCREEN_PAGE(Boolean(layout.garudaHeightCm)) + '</style>',
    );
  } catch {
    html = '';
  }
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    // Fit the 21 cm sheet to the pane's width.
    const fit = () => {
      const root = element.contentDocument?.documentElement;
      if (root) root.style.zoom = String(Math.min(1, element.clientWidth / (794 + 24)));
    };
    element.addEventListener('load', fit);
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => {
      element.removeEventListener('load', fit);
      observer.disconnect();
    };
  }, []);
  if (!html) return <p className="draft-page-empty muted">ร่างยาวเกินกว่าจะแสดงเป็นหน้ากระดาษ</p>;
  return (
    <iframe
      ref={frame}
      className="draft-page"
      title="ตัวอย่างหน้ากระดาษ"
      sandbox="allow-same-origin"
      srcDoc={html}
    />
  );
}

/** Print the page HTML; the browser's print dialog saves it as PDF with the A4 margins. */
function printHtml(html: string, title: string) {
  return new Promise<void>((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
    // Printing needs modals; scripts stay off, and the title is escaped like every other draft text.
    frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
    frame.srcdoc = html.replace(
      '<meta charset="utf-8">',
      `<meta charset="utf-8"><title>${escapeHtml(title)}</title>`,
    );
    frame.onload = async () => {
      const view = frame.contentWindow;
      if (!view) return reject(new Error('PRINT_UNAVAILABLE'));
      try {
        await view.document.fonts.ready;
        const previous = document.title;
        document.title = title;
        view.focus();
        view.print();
        document.title = previous;
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        setTimeout(() => frame.remove(), 60000);
      }
    };
    document.body.append(frame);
  });
}

type ExportInfo = {
  format: 'docx' | 'pdf';
  font: string;
  garudaHeightCm?: number;
  documentTool?: string;
  fontEmbedding?: FontEmbedding;
  fieldsNeedUpdate?: boolean;
  fontStatus?: 'available' | 'missing' | 'unknown';
};
const SETTINGS_KEY = 'step.exportSettings';
const settingsOpen = () => {
  try {
    return localStorage.getItem(SETTINGS_KEY) === 'open';
  } catch {
    return false;
  }
};

/** Desktop's export settings, file choice and the honest result of what the file contains. */
export function DraftExport({
  draft,
  title,
  documentTool,
  choice,
  onChoice,
  presentation,
  onPresentation,
  leading,
  onError,
}: {
  draft: string;
  title: string;
  documentTool?: DocumentToolId;
  choice: ExportChoice;
  onChoice: (choice: ExportChoice) => void;
  presentation: DocumentPresentation;
  onPresentation: (value: DocumentPresentation) => void;
  leading: ReactNode;
  onError: (error: unknown) => void;
}) {
  const [format, setFormat] = useState<'docx' | 'pdf' | 'md'>('docx'),
    [open, setOpen] = useState(settingsOpen),
    [busy, setBusy] = useState(false),
    [info, setInfo] = useState<ExportInfo | null>(null);
  const layout = resolveDocumentLayout(documentTool);
  const update = (change: Partial<DocumentPresentation>) =>
    onPresentation(resolvePresentation({ ...presentation, ...change }));
  const choose = (change: Partial<ExportChoice>) => {
    onChoice({ ...choice, ...change });
    setInfo(null);
  };
  const run = async () => {
    if (busy || !draft.trim()) return;
    setBusy(true);
    try {
      if (format === 'md') {
        saveBlob(new Blob([draft], { type: 'text/markdown;charset=utf-8' }), fileName(title, 'md'));
        return;
      }
      if (format === 'pdf') {
        const used = resolveDocumentLayout(
          documentTool,
          choice.font === 'auto' ? undefined : choice.font,
          choice.garuda,
        );
        await printHtml(
          exportPdfHtml(draft, { ...layoutOptions(documentTool, choice), fontFaces: fontFaces() }),
          fileName(title, 'pdf').replace(/\.pdf$/, ''),
        );
        setInfo({
          format,
          font: used.font,
          garudaHeightCm: used.garudaHeightCm,
          documentTool,
          fontStatus: 'available',
        });
        return;
      }
      const output = await exportDocx(draft, {
        ...layoutOptions(documentTool, choice),
        presentation,
        fonts: fontFile,
      });
      saveBlob(
        new Blob([output.bytes as BlobPart], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
        fileName(title, 'docx'),
      );
      setInfo({
        format,
        font: output.layout.font,
        garudaHeightCm: output.layout.garudaHeightCm,
        documentTool,
        fontEmbedding: output.fontEmbedding,
        fieldsNeedUpdate: output.fieldsNeedUpdate,
        fontStatus:
          output.fontEmbedding.status === 'embedded' ? 'available' : probeDocumentFont(output.layout.font),
      });
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const settings = format !== 'md';
  return (
    <>
      {open && settings && (
        <div className="export-settings" id="export-settings">
          {format === 'docx' && (
            <fieldset className="document-presentation" disabled={busy}>
              <legend>รูปแบบ DOCX</legend>
              <label>
                การจัดหน้า
                <select
                  aria-label="การจัดหน้า"
                  value={presentation.preset}
                  onChange={(e) => update({ preset: e.target.value as DocumentPresentation['preset'] })}
                >
                  <option value="saraban">ราชการ (สารบรรณ)</option>
                  <option value="report">รายงานทั่วไป</option>
                  <option value="book">บทความ / หนังสือ</option>
                </select>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={presentation.thaiBreaks}
                  onChange={(e) => update({ thaiBreaks: e.target.checked })}
                />
                ช่วยตัดคำไทยใน Word
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={presentation.toc}
                  onChange={(e) => update({ toc: e.target.checked })}
                />
                สารบัญจากหัวข้อระดับ 1–3
              </label>
              <label>
                ข้อความหัวกระดาษ
                <input
                  maxLength={500}
                  value={presentation.headerText}
                  onChange={(e) => update({ headerText: e.target.value })}
                />
              </label>
              <label>
                ข้อความท้ายกระดาษ
                <input
                  maxLength={500}
                  value={presentation.footerText}
                  onChange={(e) => update({ footerText: e.target.value })}
                />
              </label>
              <label>
                รูปแบบเลขหน้า
                <select
                  aria-label="รูปแบบเลขหน้า"
                  value={presentation.pageNumber}
                  onChange={(e) =>
                    update({ pageNumber: e.target.value as DocumentPresentation['pageNumber'] })
                  }
                >
                  <option value="none">ไม่ใส่เลขหน้า</option>
                  <option value="thai">หน้า ๑</option>
                  <option value="arabic-total">1 / 10</option>
                </select>
              </label>
              <label>
                ตำแหน่งเลขหน้า
                <select
                  aria-label="ตำแหน่งเลขหน้า"
                  disabled={presentation.pageNumber === 'none'}
                  value={presentation.pageNumberPosition}
                  onChange={(e) =>
                    update({
                      pageNumberPosition: e.target.value as DocumentPresentation['pageNumberPosition'],
                    })
                  }
                >
                  <option value="footer-center">ท้ายกระดาษ ตรงกลาง</option>
                  <option value="footer-right">ท้ายกระดาษ ด้านขวา</option>
                  <option value="header-right">หัวกระดาษ ด้านขวา</option>
                </select>
              </label>
              {(presentation.toc || presentation.pageNumber !== 'none') && (
                <p className="muted">
                  หากสารบัญหรือเลขหน้ายังไม่ปรับ ให้เปิดใน Word แล้วเลือก Update Field (อัปเดตเขตข้อมูล)
                </p>
              )}
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={presentation.embedFonts}
                  onChange={(e) => update({ embedFonts: e.target.checked })}
                />
                ฝังฟอนต์เพื่อเปิดและแก้ไขบนเครื่องอื่น
              </label>
            </fieldset>
          )}
          <label className="document-export-font">
            {format === 'docx' ? 'ฟอนต์ DOCX' : 'ฟอนต์ PDF'}
            <select
              aria-label={format === 'docx' ? 'ฟอนต์ DOCX' : 'ฟอนต์ PDF'}
              value={choice.font}
              onChange={(e) => choose({ font: e.target.value })}
            >
              <option value="auto">ตามแม่แบบร่าง ({layout.font})</option>
              {DOCUMENT_FONTS.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </select>
          </label>
          {['memo', 'letter'].includes(documentTool || '') && (
            <label className="document-export-font">
              ตราครุฑ
              <select
                aria-label="ตราครุฑ"
                value={choice.garuda}
                onChange={(e) => choose({ garuda: e.target.value as ExportChoice['garuda'] })}
              >
                <option value="auto">ตามประเภทเอกสาร (สูง {layout.garudaHeightCm} ซม.)</option>
                <option value="none">ไม่ใส่ตราครุฑ</option>
              </select>
            </label>
          )}
        </div>
      )}
      <footer className="artifact-footer">
        {leading}
        <span className="spacer" />
        <select
          aria-label="รูปแบบไฟล์"
          value={format}
          onChange={(e) => {
            setFormat(e.target.value as typeof format);
            setInfo(null);
          }}
        >
          <option value="docx">Word (.docx)</option>
          <option value="pdf">PDF (.pdf)</option>
          <option value="md">Markdown (.md)</option>
        </select>
        {settings && (
          <button
            className="icon-button"
            aria-label="ตั้งค่าส่งออก"
            title="ตั้งค่าส่งออก"
            aria-expanded={open}
            aria-controls="export-settings"
            onClick={() => {
              setOpen(!open);
              try {
                localStorage.setItem(SETTINGS_KEY, open ? 'closed' : 'open');
              } catch {
                // Storage can be unavailable; the panel still works for this visit.
              }
            }}
          >
            <SlidersHorizontal size={16} />
          </button>
        )}
        <button className="primary" disabled={busy || !draft.trim()} onClick={() => void run()}>
          <Download size={15} />
          ส่งออก
        </button>
      </footer>
      {info && (
        <div className="document-export-info" role="status">
          <p>ไฟล์ใช้ฟอนต์ {info.font}</p>
          <p>
            {info.garudaHeightCm ? `ตราครุฑสูง ${info.garudaHeightCm} ซม. (เฉพาะหน้าแรก)` : 'ไม่ใส่ตราครุฑ'}
          </p>
          {info.format === 'pdf' && <p>เลือก “บันทึกเป็น PDF” ในหน้าพิมพ์ ขนาด A4 ไม่ย่อหน้า</p>}
          {info.fontEmbedding?.status === 'embedded' && <p>ฝังฟอนต์ครบแล้ว เปิดและแก้ไขต่อใน Word ได้</p>}
          {info.fontEmbedding?.status === 'partial' && (
            <p>
              ฝังฟอนต์ได้บางส่วน ฟอนต์ที่ต้องตรวจบนเครื่องปลายทาง:{' '}
              {info.fontEmbedding.missingFamilies?.join(', ') || ''}
            </p>
          )}
          {info.fieldsNeedUpdate && (
            <p>หากสารบัญหรือเลขหน้ายังไม่ปรับ ให้เปิดใน Word แล้วเลือก Update Field (อัปเดตเขตข้อมูล)</p>
          )}
          {info.fontEmbedding?.status !== 'embedded' && info.fontStatus === 'missing' && (
            <p>ตรวจไม่พบฟอนต์นี้บนเครื่อง ติดตั้งฟอนต์ให้ตรงแบบก่อนตรวจหน้าใน Word</p>
          )}
          {info.fontStatus === 'unknown' && <p>ตรวจฟอนต์บนเครื่องไม่ได้ โปรดตรวจฟอนต์และหน้าใน Word</p>}
          {info.documentTool && <p>จัดหน้าตามแม่แบบร่าง ต้องเทียบแบบหน่วยงานก่อนเสนอ</p>}
        </div>
      )}
    </>
  );
}
