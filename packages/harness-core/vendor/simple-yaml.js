export function stripYamlScalar(raw = '') {
  const text = String(raw).trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text.replace(/^['"]|['"]$/g, '');
}

export function parseYamlInlineList(raw = '') {
  return String(raw)
    .split(',')
    .map((value) => stripYamlScalar(value))
    .filter(Boolean);
}

export function parseYamlBracketList(raw = '') {
  const match = String(raw).trim().match(/^\[(.*?)\]$/);
  return match ? parseYamlInlineList(match[1]) : [];
}
