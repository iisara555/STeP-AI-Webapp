export const DOCUMENT_PRESETS = {
  saraban: { points: 16, margins: { top: 2.5, bottom: 2, left: 3, right: 2 }, line: 1, indent: 1.25, after: 0 },
  report: { points: 14, margins: { top: 2.54, bottom: 2.54, left: 2.54, right: 2.54 }, line: 1.5, indent: 0, after: 6 },
  book: { points: 16, margins: { top: 2.54, bottom: 2.54, left: 3, right: 2.54 }, line: 1.3, indent: 1.25, after: 0 },
} as const;

export type DocumentPresentation = {
  preset: keyof typeof DOCUMENT_PRESETS;
  thaiBreaks: boolean;
  embedFonts: boolean;
  toc: boolean;
  headerText: string;
  footerText: string;
  pageNumber: 'none' | 'thai' | 'arabic-total';
  pageNumberPosition: 'footer-center' | 'footer-right' | 'header-right';
};

/** Presentation is local draft metadata. No generated characters are saved in the draft. */
export function resolvePresentation(value: unknown = {}, official = false): DocumentPresentation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_DOCUMENT_PRESENTATION');
  const input = value as Partial<DocumentPresentation>;
  if (
    Object.keys(input).some(
      key => !['preset', 'thaiBreaks', 'embedFonts', 'toc', 'headerText', 'footerText', 'pageNumber', 'pageNumberPosition'].includes(key),
    )
  )
    throw new Error('INVALID_DOCUMENT_PRESENTATION');
  if (input.preset !== undefined && !Object.hasOwn(DOCUMENT_PRESETS, input.preset)) throw new Error('INVALID_DOCUMENT_PRESENTATION');
  for (const key of ['thaiBreaks', 'embedFonts', 'toc'] as const)
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error('INVALID_DOCUMENT_PRESENTATION');
  for (const key of ['headerText', 'footerText'] as const)
    if (
      input[key] !== undefined &&
      (typeof input[key] !== 'string' || input[key].length > 500 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(input[key]))
    )
      throw new Error('INVALID_DOCUMENT_PRESENTATION');
  if (input.pageNumber !== undefined && !['none', 'thai', 'arabic-total'].includes(input.pageNumber))
    throw new Error('INVALID_DOCUMENT_PRESENTATION');
  if (input.pageNumberPosition !== undefined && !['footer-center', 'footer-right', 'header-right'].includes(input.pageNumberPosition))
    throw new Error('INVALID_DOCUMENT_PRESENTATION');
  return {
    preset: input.preset ?? (official ? 'saraban' : 'report'),
    thaiBreaks: input.thaiBreaks ?? true,
    embedFonts: input.embedFonts ?? true,
    toc: input.toc ?? false,
    headerText: input.headerText ?? '',
    footerText: input.footerText ?? '',
    pageNumber: input.pageNumber ?? (official ? 'thai' : 'none'),
    pageNumberPosition: input.pageNumberPosition ?? 'footer-center',
  };
}
