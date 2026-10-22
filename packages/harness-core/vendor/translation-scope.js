/** Explicit targets outside Thai/English belong to the host's general assistant. */
export function translationTargetInScope(text = '') {
  // Prefer the language introduced by "into" over a recipient inside the source ("send to Acme").
  const english = /\binto\s+([a-z]+)\b/i.exec(text) || /\bto\s+([a-z]+)\b/i.exec(text);
  if (english && !['the', 'a', 'my', 'our', 'your', 'this', 'their', 'them', 'us'].includes(english[1].toLowerCase())) {
    return /^(?:thai|english)$/i.test(english[1]);
  }
  const thai = /เป็น(?:ภาษา)?\s*([ก-๙]+)/.exec(text);
  return !thai || /^(?:ไทย|อังกฤษ)/.test(thai[1]);
}
