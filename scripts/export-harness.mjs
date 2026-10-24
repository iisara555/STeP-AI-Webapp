// Run locally beside an authorized Desktop checkout. Output is private data.
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import { skillTitle } from '../packages/harness-core/src/skill-labels.ts';
import { skillSupport } from './harness-support.mjs';
const { values } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' } } });
if (!values.source) throw new Error('Use --source /path/to/authorized/STeP-AI-Harness');
const root = await realpath(resolve(values.source));
const out = resolve(values.out || '.exports/harness-pack.json');
const own = relative(process.cwd(), out).split(sep).join('/');
if (!own.startsWith('..') && !isAbsolute(own) && !own.startsWith('.exports/'))
  throw new Error('Exports inside this repository must be under .exports/');
async function text(path) {
  const target = await realpath(resolve(root, path)),
    child = relative(root, target);
  if (child.startsWith('..') || isAbsolute(child)) throw new Error('SOURCE_OUTSIDE_ROOT');
  const value = await readFile(target, 'utf8');
  if (
    /\b(?:sk-|ghp_|github_pat_|AIza)[A-Za-z0-9_-]{24,}|\bAQ\.[A-Za-z0-9_-]{24,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(
      value,
    )
  )
    throw new Error('SECRET_DETECTED');
  return value;
}
const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('SOURCE_COMMIT_REQUIRED');
const { loadDocumentCatalog } = await import(
  pathToFileURL(resolve(root, 'src/modules/router/metadata.js')).href
);
const catalog = await loadDocumentCatalog();
const sources = [];
for (const entry of catalog) {
  const body = await text(entry.path);
  if (body.length > 200000) throw new Error('SOURCE_TOO_LARGE: ' + entry.id);
  sources.push({
    source_key: entry.id,
    title: entry.title,
    body,
    source_version: commit,
    provenance: { ...entry, sha256: createHash('sha256').update(body).digest('hex') },
  });
}
for (const [key, path] of [
  ['__authority', 'manifest/authority.yaml'],
  ['__organization', 'manifest/organization.yaml'],
])
  sources.push({
    source_key: key,
    title: key,
    body: await text(path),
    source_version: commit,
    provenance: { path },
  });
const registry = yaml.load(await text('manifest/skills.yaml'));
const router = yaml.load(await text('manifest/router-index.yaml'));
const documentRegistry = yaml.load(await text('manifest/documents.yaml'));
const excluded = new Set([
  'not-provided',
  'superseded',
  'archived',
  'withdrawn',
  'restricted',
  'unregistered',
]);
const deniedPaths = new Set(
  Object.values(documentRegistry.documents)
    .filter((d) => d.sensitivity === 'restricted' || excluded.has(d.status))
    .flatMap((d) => [d.path, d.index].filter(Boolean)),
);
const skills = [];
for (const [key, entry] of Object.entries(registry.skills)) {
  if (!entry.path || ['retired', 'archived', 'draft'].includes(entry.governance?.lifecycle?.stage)) continue;
  const instructions = await text(entry.path);
  if (instructions.length > 60000) throw new Error('SKILL_TOO_LARGE: ' + key);
  const front = instructions.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const metadata = front ? yaml.load(front[1]) : {};
  const route = router.skills.find((s) => s.name === key) || {};
  const supportKeys = [];
  // Restricted/retired registry entries remain excluded even if a Skill links to their file.
  for (const support of await skillSupport(root, dirname(entry.path), deniedPaths)) {
    const existing = sources.find((s) => s.provenance.path === support.path);
    const sourceKey =
      existing?.source_key ||
      'support-' + createHash('sha256').update(support.path).digest('hex').slice(0, 32);
    supportKeys.push(sourceKey);
    if (!existing)
      sources.push({
        source_key: sourceKey,
        title: support.path.split('/').slice(-2).join('/'),
        body: support.body,
        source_version: commit,
        provenance: {
          path: support.path,
          kind: 'skill-support',
          skill_key: key,
          verification: 'working-reference',
          sha256: createHash('sha256').update(support.body).digest('hex'),
        },
      });
  }
  skills.push({
    skill_key: key,
    title: skillTitle(key, metadata.name || key),
    description: String(route.description || entry.description || '').slice(0, 600),
    instructions,
    metadata: {
      ...route,
      owner: entry.owner || 'common',
      stage: entry.governance?.lifecycle?.stage || 'unregistered',
      skill_version: entry.version || '',
      source_path: entry.path,
      optional_source_keys: entry.references?.optional || [],
      support_source_keys: supportKeys,
      missing_required_source_keys: (entry.references?.mandatory || []).filter(
        (k) => !sources.some((s) => s.source_key === k),
      ),
      developerOnly: ['ai-admin', 'developer'].includes(entry.owner),
      webUnsupported: ['browser-form-assistant'].includes(key),
      required_source_keys: entry.references?.mandatory || [],
    },
    source_version: commit,
  });
}
const pack = {
  format: 'step-harness-pack/v1',
  sourceCommit: commit,
  exportedAt: new Date().toISOString(),
  sources,
  skills,
};
const output = JSON.stringify(pack);
if (sources.length > 500 || skills.length > 200) throw new Error('PACK_RECORD_LIMIT');
if (Buffer.byteLength(output) > 20 * 1024 * 1024) throw new Error('PACK_TOO_LARGE');
await mkdir(dirname(out), { recursive: true, mode: 0o700 });
await writeFile(out, output, { flag: 'wx', mode: 0o600 });
console.log(
  JSON.stringify({
    sourceCommit: commit,
    documents: sources.length,
    skills: skills.length,
    sha256: createHash('sha256').update(output).digest('hex'),
    output: out,
  }),
);
