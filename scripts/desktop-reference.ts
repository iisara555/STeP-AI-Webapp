import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { DESKTOP_BASELINE, DESKTOP_FEATURES } from '../packages/harness-core/src/desktop-reference.ts';
const { values } = parseArgs({ options: { source: { type: 'string' }, write: { type: 'boolean' } } });
const inventoryPath = 'docs/desktop-inventory.json';
type Inventory = {
  format: string;
  sourceCommit: string;
  desktopVersion: string;
  modules: { path: string; sha256: string; features: string[] }[];
};
let inventory: Inventory;
if (values.source) {
  const source = resolve(values.source);
  const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (commit !== DESKTOP_BASELINE.commit) throw new Error('BASELINE_CHANGED_REVIEW_REQUIRED');
  for (const path of new Set(DESKTOP_FEATURES.flatMap((f) => f.sources))) await access(resolve(source, path));
  const modules = [];
  for (const name of (await readdir(resolve(source, 'desktop/src')))
    .filter((n) => /\.(ts|tsx)$/.test(n))
    .sort()) {
    const path = 'desktop/src/' + name;
    const features = DESKTOP_FEATURES.filter((f) => f.sources.includes(path)).map((f) => f.id);
    if (!features.length) throw new Error('UNMAPPED_DESKTOP_MODULE: ' + path);
    modules.push({
      path,
      sha256: createHash('sha256')
        .update(await readFile(resolve(source, path)))
        .digest('hex'),
      features,
    });
  }
  inventory = {
    format: 'step-desktop-reference/v1',
    sourceCommit: commit,
    desktopVersion: DESKTOP_BASELINE.version,
    modules,
  };
  if (values.write) await writeFile(inventoryPath, JSON.stringify(inventory, null, 2) + '\n');
} else inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
if (
  inventory.sourceCommit !== DESKTOP_BASELINE.commit ||
  inventory.desktopVersion !== DESKTOP_BASELINE.version
)
  throw new Error('REFERENCE_OUTDATED');
for (const item of inventory.modules) {
  if (
    !/^[a-f0-9]{64}$/.test(item.sha256) ||
    !item.features.length ||
    !item.features.every((id) => DESKTOP_FEATURES.some((f) => f.id === id && f.sources.includes(item.path)))
  )
    throw new Error('REFERENCE_INVALID');
}
if (!values.write && values.source) {
  const saved = JSON.parse(await readFile(inventoryPath, 'utf8'));
  if (JSON.stringify(saved) !== JSON.stringify(inventory)) throw new Error('SOURCE_INVENTORY_DRIFT');
}
console.log(
  JSON.stringify({
    sourceCommit: inventory.sourceCommit,
    featureGroups: DESKTOP_FEATURES.length,
    desktopModules: inventory.modules.length,
    sourceVerified: Boolean(values.source),
  }),
);
