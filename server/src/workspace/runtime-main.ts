// Entry of one Workspace runtime process (process driver). It opens the pinned Desktop engine headless on this
// Workspace's own <dir>/workspace.sqlite (ADR 0001 phase 2) and answers the Manager over its private channel.
// The provider token arrives by `connect` and stays in this process's memory only.
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CompatibleAdapter } from '../../../harness/desktop/electron/providers.ts';
import { searchPublicWeb } from '../../../harness/desktop/electron/public-search.ts';
import { createEngine } from '../engine.ts';
import {
  AskInput,
  ProviderGrant,
  SessionRef,
  type AskResult,
  type ConversationMessage,
  type ConversationSummary,
  type RuntimeEvent,
} from './contract.ts';
import type { RuntimeReply, RuntimeRequest } from './process-driver.ts';

const workspaceId = process.env.STEP_WORKSPACE_ID;
const dir = process.env.STEP_WORKSPACE_DIR;
const started = Date.now();
const send = process.send?.bind(process);

if (!send || !workspaceId || !dir || process.cwd() !== join(dir, 'files')) process.exit(2);
await access(dir, constants.R_OK | constants.W_OK);

const reply = (message: RuntimeReply) => send!(message);
const FORWARDED = new Set(['delta', 'discard', 'activity', 'status']);
let grant: ReturnType<typeof ProviderGrant.parse> | undefined;
const engine = await createEngine({
  dataDir: dir,
  runtime: async () => ({
    adapter: new CompatibleAdapter(),
    context: { cwd: join(dir, 'files'), env: {}, key: grant?.token },
  }),
  publicSearch: async (query, signal) =>
    grant?.publicSearch ? searchPublicWeb(query, signal, engine.policy.network?.proxyUrl) : '',
  // Only the answer as it streams and short progress lines go to the Manager, for the Workspace's owner.
  emit: (event) => {
    if (!FORWARDED.has(event.type) || !event.sessionId) return;
    const forwarded: RuntimeEvent = { sessionId: event.sessionId, type: event.type as RuntimeEvent['type'] };
    if (typeof event.text === 'string') forwarded.text = event.text;
    if (typeof (event as { count?: unknown }).count === 'number')
      forwarded.count = (event as { count: number }).count;
    reply({ type: 'event', event: forwarded });
  },
});

const methods: Record<string, (params: unknown) => unknown> = {
  health: () => ({
    ok: true,
    workspaceId,
    pid: process.pid,
    uptimeMs: Date.now() - started,
    cwd: process.cwd(),
  }),
  connect(params) {
    grant = ProviderGrant.parse(params);
    // The connection row carries no secret: the key is handed to the adapter per run from memory.
    engine.store.put('connection', 'central', {
      id: 'central',
      provider: 'compatible',
      mode: 'api',
      protocol: 'openai',
      baseUrl: grant.baseUrl,
      model: grant.model,
      ready: true,
    });
    return { ok: true };
  },
  async ask(params): Promise<AskResult> {
    if (!grant) throw new Error('PROVIDER_NOT_CONNECTED');
    const { text, sessionId } = AskInput.parse(params);
    const id = sessionId ?? engine.store.create('central', 'cc').id;
    if (!engine.store.get('session', id)) throw new Error('CONVERSATION_NOT_FOUND');
    await engine.work.run(id, text, '', true, undefined, 'chat');
    const done = engine.store.session(id);
    const answer = done.messages.filter((m) => m.role === 'assistant').at(-1)?.text;
    return {
      sessionId: id,
      status: done.status,
      ...(answer ? { answer } : {}),
      ...(done.status === 'review' ? {} : { code: done.runs?.at(-1)?.code || 'RUN_FAILED' }),
      sources: done.loadedContext ?? [],
    };
  },
  newConversation: () => ({ sessionId: engine.store.create('central', 'cc').id }),
  cancel(params) {
    const { sessionId } = SessionRef.parse(params);
    if (!engine.store.get('session', sessionId)) throw new Error('CONVERSATION_NOT_FOUND');
    engine.work.cancel(sessionId);
    return { ok: true };
  },
  messages(params): ConversationMessage[] {
    const { sessionId } = SessionRef.parse(params);
    if (!engine.store.get('session', sessionId)) throw new Error('CONVERSATION_NOT_FOUND');
    return engine.store
      .session(sessionId)
      .messages.filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m: any) => ({ role: m.role, text: m.text || '', ...(m.at ? { at: m.at } : {}) }));
  },
  conversations: (): ConversationSummary[] =>
    engine.store.list('session').map((s: any) => ({
      id: s.id,
      title: s.title || '',
      status: s.status,
      ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
    })),
};

process.on('message', async ({ nonce, method, params }: RuntimeRequest) => {
  const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
  try {
    if (!handler) throw new Error('UNKNOWN_METHOD');
    reply({ type: 'result', nonce, ok: true, result: await handler(params) });
  } catch (error) {
    // Only a code crosses the channel: engine and provider messages may quote the user's content.
    const code =
      error instanceof z.ZodError
        ? 'INVALID_INPUT'
        : error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)
          ? error.message
          : 'RUNTIME_CALL_FAILED';
    reply({ type: 'result', nonce, ok: false, code });
  }
});
// The Manager going away is the same as a stop: no runtime outlives its supervisor.
process.on('disconnect', () => {
  engine.close();
  process.exit(0);
});
reply({ type: 'ready' });
