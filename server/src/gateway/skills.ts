// The organization's Skills as the web's Skills page shows them, read from the pinned harness (the same files the
// engine uses), in the shape scripts/export-harness.mjs gives the Supabase pilot. Retired, archived and draft Skills
// and the administrators' and developers' Skills are left out, so a person can only see and pick what staff may use.
import { readdir, readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';
import { skillTitle } from '../../../packages/harness-core/src/skill-labels.ts';

export type SkillView = {
  id: string;
  skill_key: string;
  title: string;
  description: string;
  /** Only in `read`; the list leaves it empty. */
  instructions: string;
  metadata: Record<string, unknown>;
  source_version: string;
};

export type SkillLibrary = {
  list(): Promise<SkillView[]>;
  /** One Skill with its instructions, or undefined when staff cannot use it. */
  read(key: string): Promise<SkillView | undefined>;
  /** True when a run may name this Skill: staff may use it and the web supports it. */
  usable(key: string): Promise<boolean>;
};

export const SkillKey = /^[a-z0-9][a-z0-9-]{0,80}$/;
const HIDDEN_STAGES = new Set(['retired', 'archived', 'draft']);
const STAFF_HIDDEN_OWNERS = new Set(['ai-admin', 'developer']);
/** Same folder as engine.ts's HARNESS_ROOT; not imported, so the Gateway's type check stays out of the engine. */
const HARNESS_ROOT = resolve(import.meta.dirname, '../../../harness');
/** Skills that need Desktop's browser and the person's own sign-ins. */
const DESKTOP_ONLY = new Set(['browser-form-assistant']);
/** Router fields a person sees; file paths and internal ids stay on the server. */
const ROUTE_FIELDS = ['cluster', 'domain', 'intent', 'teams', 'triggers', 'scope', 'requires'] as const;

async function inside(root: string, path: string) {
  const target = await realpath(resolve(root, path));
  const child = relative(root, target);
  if (child.startsWith('..') || isAbsolute(child)) throw new Error('SKILL_OUTSIDE_HARNESS');
  return target;
}

async function supportFiles(dir: string) {
  let count = 0;
  for (const folder of ['references', 'templates', 'examples']) {
    try {
      const names = await readdir(join(dir, folder), { recursive: true });
      count += names.filter((name) =>
        ['.md', '.txt', '.yaml', '.yml', '.json', '.csv'].includes(extname(name)),
      ).length;
    } catch {
      // A Skill without this folder.
    }
  }
  return count;
}

async function load(root: string, version: string) {
  root = await realpath(root);
  const registry = yaml.load(await readFile(join(root, 'manifest/skills.yaml'), 'utf8')) as {
    skills: Record<string, any>;
  };
  const router = yaml.load(await readFile(join(root, 'manifest/router-index.yaml'), 'utf8')) as {
    skills: any[];
  };
  const { loadDocumentCatalog } = await import(
    pathToFileURL(join(root, 'src/modules/router/metadata.js')).href
  );
  const documents = new Set<string>((await loadDocumentCatalog()).map((entry: { id: string }) => entry.id));

  const skills = new Map<string, SkillView>();
  for (const [key, entry] of Object.entries(registry.skills)) {
    if (!SkillKey.test(key) || !entry?.path) continue;
    if (HIDDEN_STAGES.has(entry.governance?.lifecycle?.stage) || STAFF_HIDDEN_OWNERS.has(entry.owner))
      continue;
    const file = await inside(root, entry.path);
    const instructions = await readFile(file, 'utf8');
    const front = instructions.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const meta = (front ? yaml.load(front[1]) : {}) as { name?: string };
    const route = router.skills.find((skill) => skill.name === key) ?? {};
    const required: string[] = entry.references?.mandatory ?? [];
    skills.set(key, {
      id: key,
      skill_key: key,
      title: skillTitle(key, meta.name || key),
      description: String(route.description || entry.description || '').slice(0, 600),
      instructions,
      metadata: {
        ...Object.fromEntries(
          ROUTE_FIELDS.filter((field) => field in route).map((field) => [field, route[field]]),
        ),
        owner: entry.owner || 'common',
        stage: entry.governance?.lifecycle?.stage || 'unregistered',
        skill_version: entry.version || '',
        required_source_keys: required,
        missing_required_source_keys: required.filter((id) => !documents.has(id)),
        optional_source_keys: entry.references?.optional ?? [],
        support_source_keys: Array.from(
          { length: await supportFiles(join(file, '..')) },
          (_, i) => `support-${i}`,
        ),
        developerOnly: false,
        webUnsupported: DESKTOP_ONLY.has(key),
      },
      source_version: version,
    });
  }
  return skills;
}

/** Reads the harness once; the pinned harness changes only with a new deploy, which restarts the Gateway. */
export function skillLibrary(root = HARNESS_ROOT): SkillLibrary {
  let loading: Promise<Map<string, SkillView>> | undefined;
  const all = () => {
    loading ??= (async () => {
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: string };
      return load(root, `harness ${pkg.version ?? ''}`.trim());
    })();
    // A failed read (a missing file mid-deploy) is tried again on the next request.
    void loading.catch(() => (loading = undefined));
    return loading;
  };
  return {
    async list() {
      return [...(await all()).values()].map((skill) => ({ ...skill, instructions: '' }));
    },
    async read(key) {
      if (!SkillKey.test(key)) return undefined;
      const skill = (await all()).get(key);
      return skill && structuredClone(skill);
    },
    async usable(key) {
      const skill = SkillKey.test(key) ? (await all()).get(key) : undefined;
      return Boolean(skill && !skill.metadata.webUnsupported);
    },
  };
}
