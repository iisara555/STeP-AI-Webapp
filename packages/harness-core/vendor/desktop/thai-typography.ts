import type { DraftNode } from './draft.ts';

// ICU boundaries also supply optional break opportunities in a detached DOCX export copy.
const words = new Intl.Segmenter('th', { granularity: 'word' });
const graphemes = new Intl.Segmenter('th', { granularity: 'grapheme' });

export const THAI_DOCUMENT_LANGUAGE = { value: 'th-TH' } as const;
export const THAI_DOCUMENT_CSS = 'word-break:normal;overflow-wrap:break-word;line-break:auto;hyphens:none;';

/** Approximate visible units; combining vowels/tones and emoji sequences are not counted as separate letters. */
export function textUnits(text: string) {
  let count = 0;
  for (const _part of graphemes.segment(text)) count++;
  return count;
}

/** A Thai header may have many words without spaces. Do not shrink an entire table to fit it on one line. */
export function longestWordUnits(text: string) {
  let longest = 0;
  for (const part of words.segment(text)) {
    if (!part.segment.trim()) continue;
    longest = Math.max(longest, textUnits(part.segment));
  }
  return longest;
}

/** Segment the entire paragraph, including words crossing emphasis runs. Source nodes are never mutated. */
export function withThaiBreaks(node: DraftNode): DraftNode {
  if (!['paragraph', 'heading', 'title', 'caption'].includes(node.type))
    return { ...node, ...(node.content ? { content: node.content.map(withThaiBreaks) } : {}) };
  const text = (node.content || []).map(n => (n.type === 'hardBreak' ? '\n' : n.text || '')).join('');
  const protectedRanges = [...text.matchAll(/(?:https?:\/\/|www\.)\S+|[\w.+-]+@\S+|[\p{L}_]*[0-9๐-๙][\p{L}\p{N}_./:\\-]*/gu)].map(m => [
    m.index!,
    m.index! + m[0].length,
  ]);
  const boundaries = new Set([...graphemes.segment(text)].map(p => p.index));
  const thaiLetter = /[\u0e01-\u0e3a\u0e40-\u0e4e]/;
  const breaks = new Set<number>();
  for (const part of words.segment(text)) {
    const at = part.index;
    if (
      at &&
      boundaries.has(at) &&
      thaiLetter.test(text[at - 1]) &&
      thaiLetter.test(text[at]) &&
      !protectedRanges.some(([start, end]) => at > start && at < end)
    )
      breaks.add(at);
  }
  let offset = 0;
  return {
    ...node,
    content: (node.content || []).map(child => {
      if (child.type === 'hardBreak') {
        offset++;
        return { ...child };
      }
      let value = '';
      for (const char of child.text || '') {
        if (breaks.has(offset)) value += '\u200b';
        value += char;
        offset += char.length;
      }
      return { ...child, text: value };
    }),
  };
}

/**
 * UI copy: Thai writes a space between phrases, and the line-break dictionary also splits compounds the eye reads as
 * one word ("งบ|ประมาณ", "ผู้รับ|ผิด|ชอบ", "รุ่น|นี้"). Short space-separated phrases are kept whole; a longer run
 * keeps the dictionary's breaks so it can still wrap inside a narrow card.
 */
export function thaiPhrases(text: string, maxUnits = 16): { text: string; keep: boolean }[] {
  return text
    .split(/(\s+)/)
    .filter(Boolean)
    .map(part => ({ text: part, keep: !/^\s+$/.test(part) && /[ก-๎]/.test(part) && textUnits(part) <= maxUnits }));
}
