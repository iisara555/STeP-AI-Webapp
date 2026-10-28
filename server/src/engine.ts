// Runs the Desktop engine (harness/desktop/electron) without Electron, for one employee at a time.
// ADR 0001: the engine comes from the pinned Harness submodule and is never copied here.
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../../harness/desktop/electron/store.ts';
import { WorkService, type Harness } from '../../harness/desktop/electron/service.ts';
import { defaultPolicy, type Policy } from '../../harness/desktop/electron/policy.ts';
import { searchPublicWeb } from '../../harness/desktop/electron/public-search.ts';
import type { ProviderAdapter, ProviderContext } from '../../harness/desktop/electron/providers.ts';
import type { Connection, RunEvent } from '../../harness/desktop/src/types.ts';
import { PUBLIC_WEB_INSTRUCTIONS, publicWebHost, type PublicWebOptions } from './public-web.ts';

export const HARNESS_ROOT = resolve(import.meta.dirname, '../../harness');

/**
 * The server profile of the Desktop policy. The privacy check is on because staff data passes through a shared
 * machine; authority checks keep the Desktop default. The tool loop stays off unless the single-user CLI
 * opts in to the restricted public web host; Cloud Workspace does not enable it.
 */
export function serverPolicy(options: { publicWeb?: boolean } = {}): Policy {
  const policy = defaultPolicy();
  policy.source = 'managed';
  policy.checks = { ...policy.checks, privacy: true };
  for (const off of [
    'toolLoop',
    'hybridSkillSelection',
    'autoMode',
    'shellByAi',
    'autopilot',
    'sandbox',
    'mcp',
    'copilot',
    'compatibleProviders',
    'headless',
    'staffSkills',
    'vault',
  ] as const)
    policy.features[off] = false;
  policy.features.toolLoop = options.publicWeb === true;
  return policy;
}

export type Runtime = (
  connection: Connection,
  webSearch?: boolean,
) => Promise<{ adapter: ProviderAdapter; context: Omit<ProviderContext, 'signal' | 'emit'> }>;

export type EngineOptions = {
  /** This employee's own folder; the engine keeps its SQLite file and work files there and nowhere else. */
  dataDir: string;
  runtime: Runtime;
  emit?: (event: RunEvent) => void;
  policy?: Policy;
  root?: string;
  /** Public web search for public facts; tests pass a synthetic one. */
  publicSearch?: (query: string, signal: AbortSignal) => Promise<string>;
  /** Explicit per-run consent for the public-only CLI trial; absent for Workspace runtimes. */
  publicWeb?: { fetchPage?: PublicWebOptions['fetchPage'] };
};

const load = (root: string, path: string) => import(pathToFileURL(join(root, path)).href);

export async function createEngine({
  dataDir,
  runtime,
  emit = () => {},
  policy = serverPolicy(),
  root = HARNESS_ROOT,
  publicWeb,
  publicSearch = (query, signal) => searchPublicWeb(query, signal, policy.network?.proxyUrl),
}: EngineOptions) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const [routing, routerPolicy, privacy, documents, outputs, skillCatalog] = await Promise.all([
    load(root, 'src/modules/router/service.js'),
    load(root, 'src/modules/router/index.js'),
    load(root, 'src/modules/privacy/index.js'),
    load(root, 'src/modules/privacy/document.js'),
    load(root, 'src/modules/output-manager.js'),
    load(root, 'src/modules/skills/catalog.js'),
  ]);
  const store = new Store(join(dataDir, 'workspace.sqlite'));
  if (!store.settings().workspace) store.put('settings', 'main', { ...store.settings(), workspace: dataDir });
  // As in electron/main.ts, without the Vault masking (vault is off on the server) and without Electron paths.
  const scanText = (text: string, options?: any) => privacy.evaluatePrivacyGate(text, options);
  const harness: Harness = {
    permissionMode: () => 'ask',
    memoryDir: () => dataDir,
    root,
    route: (query: string, options: any = {}) =>
      routing.queryStepRouter(query, {
        autoRoute: policy.features.autoRouting,
        authorityChecks: policy.checks.authority,
        ...options,
      }),
    contextPolicy: routerPolicy.classifyContextPolicy,
    modelLimits: (connection) =>
      policy.modelLimits?.[connection.model] || policy.modelLimits?.[connection.provider + ':*'] || {},
    privacy: scanText,
    publicSearch: async (query, signal) => {
      const found = await publicSearch(query, signal);
      // WorkService records returned sources. Reject unreviewed content before it enters its trace.
      if (publicWeb) {
        const review = scanText(found);
        if (review.action !== 'pass' || review.redactedText !== found)
          throw new Error('PRIVACY_REVIEW_REQUIRED');
      }
      return found;
    },
    catalog: skillCatalog.createSkillCatalog(root),
    documentMetadata: routing.loadDocumentContextMetadata,
    documentCatalog: routing.loadDocumentCatalog,
    toolLoop: () => Boolean(publicWeb && policy.features.toolLoop),
    ...(publicWeb && policy.features.toolLoop
      ? {
          toolInstructions: () => PUBLIC_WEB_INSTRUCTIONS,
          tools: async (scope) =>
            publicWebHost(scope, { privacy: scanText, proxyUrl: policy.network?.proxyUrl, ...publicWeb }),
        }
      : {}),
    hybridSkillSelection: () => policy.features.hybridSkillSelection,
    visionEnabled: () => policy.features.vision,
    answerCheck: () => policy.features.answerCheck,
    autoEffort: () => policy.features.autoEffort,
    skillMetadata: async (id) => {
      const m = await routing.loadSkillContextMetadata(id);
      return { ...m, mandatoryReferences: await routing.loadDocumentContextMetadata(m?.mandatory || []) };
    },
    documentPrivacy: (path: string, options: any = {}) =>
      documents.evaluateDocumentPrivacy(path, { ...options, scan: policy.checks.privacy }),
    nextOutput: outputs.getNextOutputPath,
  };
  const work = new WorkService(store, harness, runtime, emit);
  return { store, work, harness, policy, close: () => store.close() };
}

export type Engine = Awaited<ReturnType<typeof createEngine>>;
