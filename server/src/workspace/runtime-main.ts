// Entry of one Workspace runtime process (process driver). It opens the pinned Desktop engine headless on this
// Workspace's own <dir>/workspace.sqlite (ADR 0001 phase 2) and answers the Manager over its private channel.
// The provider token arrives by `connect` and stays in this process's memory only.
import { access, constants, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
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
import { currentRunResult } from './current-run-result.ts';
import type { RuntimeReply, RuntimeRequest } from './process-driver.ts';
import { CONVERSATION_INDEX } from './storage.ts';
import { DEFAULT_MAX_FRAME_BYTES, encodeFrame, frameReader } from './frames.ts';

// All new runtime files, including SQLite sidecars, are private to the service account.
process.umask(0o077);
const workspaceId = process.env.STEP_WORKSPACE_ID;
const dir = process.env.STEP_WORKSPACE_DIR;
const started = Date.now();
// Two channels: Node fork IPC (process driver), or, where an account switch closes fd 3 (step-runner driver), the
// per-sandbox Unix socket whose first frame must echo the launch nonce.
const socketPath = process.env.STEP_RUNTIME_SOCKET;
// The launch nonce arrives on stdin, never in argv or the environment.
const launchNonce = socketPath ? await readNonce() : undefined;
if (socketPath && !launchNonce) process.exit(2);
async function readNonce() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 200) break;
  }
  process.stdin.destroy();
  return /^([0-9a-f]{64})\n$/.exec(text)?.[1];
}
let closeEngine = () => {};
const channel = socketPath ? createConnection(socketPath) : undefined;
if (channel) {
  await new Promise<void>((done) => {
    channel.once('connect', done);
    channel.once('error', () => process.exit(2));
  });
  // The Manager going away is the same as a stop: no runtime outlives its supervisor.
  channel.on('close', () => {
    closeEngine();
    process.exit(0);
  });
}
const send = channel
  ? (message: RuntimeReply) => void channel.write(encodeFrame(message))
  : process.send?.bind(process);

if (!send || !workspaceId || !dir || process.cwd() !== join(dir, 'files')) process.exit(2);
await access(dir, constants.R_OK | constants.W_OK);

let syntheticBaseUrl: string | undefined;
if (process.env.STEP_SYNTHETIC_PROVIDER === '1') {
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* never leave the sandbox */
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'คำตอบจำลองจาก Desktop engine' } }] })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('SYNTHETIC_PROVIDER_FAILED');
  syntheticBaseUrl = `http://127.0.0.1:${address.port}/v1`;
}
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

const listConversations = (): ConversationSummary[] =>
  engine.store.list('session').map((s: any) => ({
    id: s.id,
    title: s.title || '',
    status: s.status,
    ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
  }));
/** Keeps <dir>/conversations.json current, so the Manager can list this Workspace after it stops. */
let indexing: Promise<void> = Promise.resolve();
const writeIndex = () => {
  const file = join(dir, CONVERSATION_INDEX);
  indexing = indexing
    .then(async () => {
      await writeFile(file + '.tmp', JSON.stringify(listConversations()), { mode: 0o600 });
      await rename(file + '.tmp', file);
    })
    .catch(() => {});
  return indexing;
};

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
    if (syntheticBaseUrl)
      grant = { ...grant, baseUrl: syntheticBaseUrl, token: 'synthetic', publicSearch: false };
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
    const before = engine.store.session(id);
    try {
      await engine.work.run(id, text, '', true, undefined, 'chat');
    } finally {
      await writeIndex();
    }
    return currentRunResult(id, before, engine.store.session(id));
  },
  async newConversation() {
    const sessionId = engine.store.create('central', 'cc').id;
    await writeIndex();
    return { sessionId };
  },
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
  conversations: listConversations,
};

const answer = async ({ nonce, method, params }: RuntimeRequest) => {
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
};
closeEngine = () => engine.close();
if (channel) {
  const push = frameReader(
    DEFAULT_MAX_FRAME_BYTES,
    (frame) => {
      const request = frame as RuntimeRequest;
      if (request?.type === 'call' && typeof request.nonce === 'number' && typeof request.method === 'string')
        void answer(request);
    },
    () => channel.destroy(),
  );
  channel.on('data', (chunk: Buffer) => push(chunk));
} else {
  process.on('message', answer);
  // The Manager going away is the same as a stop: no runtime outlives its supervisor.
  process.on('disconnect', () => {
    engine.close();
    process.exit(0);
  });
}
await writeIndex();
reply(launchNonce ? { type: 'ready', launchNonce } : { type: 'ready' });
