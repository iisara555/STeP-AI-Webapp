// Copy the shared palette and scales from a STeP-AI-Harness checkout: node scripts/sync-theme.mjs <harness path>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const harness = process.argv[2];
if (!harness) {
  console.error('usage: node scripts/sync-theme.mjs <path to STeP-AI-Harness>');
  process.exit(1);
}
const target = 'web/src/theme.css';
const header = readFileSync(target, 'utf8').match(/^\/\*[\s\S]*?\*\/\n/)[0];
writeFileSync(target, header + readFileSync(join(harness, 'desktop/src/theme.css'), 'utf8'));
console.log(`Copied ${join(harness, 'desktop/src/theme.css')} to ${target}`);
