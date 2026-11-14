import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

// The web app uses the Desktop palette and scales unchanged (web/src/theme.css, copied by scripts/sync-theme.mjs).
const web = readFileSync('web/src/theme.css', 'utf8');
const body = web.replace(/^\/\*[\s\S]*?\*\/\n/, '');

test('the web theme carries the STeP palette and the shared type, spacing and radius scales', () => {
  for (const value of [
    '--accent: #ffc709',
    '--text: #231f20',
    '--text-xs: 12px',
    '--space-4: 16px',
    '--radius-pill: 999px',
  ])
    assert.ok(body.includes(value), value);
  const styles = readFileSync('web/src/styles.css', 'utf8');
  assert.match(styles, /^@import '\.\/theme\.css';/);
  // Colours are defined once, in the shared theme; styles.css adds only the web-only state fills.
  assert.doesNotMatch(styles, /--accent:|--surface:|--text:/);
});

test('the web theme matches the harness Desktop theme when the submodule has the scales', () => {
  const desktop = 'harness/desktop/src/theme.css';
  const pinned = existsSync(desktop) ? readFileSync(desktop, 'utf8') : '';
  // An older pinned tag predates the scales; the copy is then ahead of the pin, never different in its colours.
  if (pinned.includes('--text-xs')) assert.equal(body, pinned);
  else
    for (const line of pinned.split('\n').filter((l) => /^\s*--[\w-]+:/.test(l)))
      assert.ok(body.includes(line.trim()), line);
});
