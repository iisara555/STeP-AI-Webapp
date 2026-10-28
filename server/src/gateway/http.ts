// The Gateway's HTTP surface (ADR 0001 §3). The browser reaches Workspaces only through these routes: no runtime
// port, IPC channel, Docker socket or SQLite file is ever exposed. Every route but /healthz needs an invited
// identity, and a Workspace or run is found only under its owner.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { AskInput, WorkspaceError, WorkspaceName } from '../workspace/contract.ts';
import type { RuntimeManager } from '../workspace/manager.ts';
import type { Audit } from './audit.ts';
import type { Authenticator, Identity } from './auth.ts';
import { codeOf, DEFAULT_QUOTAS, GatewayError, type Quotas, type RunService } from './runs.ts';

export type GatewayOptions = {
  manager: RuntimeManager;
  runs: RunService;
  authenticate: Authenticator;
  audit: Audit;
  /** The web app's origin; requests from any other browser origin are refused. */
  origin?: string;
  quotas?: Quotas;
  heartbeatMs?: number;
  now?: () => number;
};

const BODY_LIMIT = 64 * 1024;
const STATUS: Record<string, number> = {
  INVALID_ID: 400,
  INVALID_NAME: 400,
  INVALID_INPUT: 400,
  INVALID_JSON: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  ORIGIN_DENIED: 403,
  NOT_FOUND: 404,
  WORKSPACE_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  CONVERSATION_NOT_FOUND: 404,
  RUN_ALREADY_ACTIVE: 409,
  RUN_NOT_ACTIVE: 409,
  RUNTIME_NOT_RUNNING: 409,
  BODY_TOO_LARGE: 413,
  QUOTA_WORKSPACES: 429,
  QUOTA_ACTIVE_RUNS: 429,
  QUOTA_DAILY_RUNS: 429,
  RUNTIME_CAPACITY: 503,
  PROVIDER_NOT_CONNECTED: 503,
  AUTH_KEYS_UNAVAILABLE: 503,
};

const CreateWorkspace = z.object({ name: WorkspaceName });

type Context = { req: IncomingMessage; res: ServerResponse; who: Identity; params: string[] };
type Route = [method: string, pattern: RegExp, handler: (ctx: Context) => Promise<unknown>];

const WS = '(ws_[0-9a-f]{32})';
const RUN = '(run_[0-9a-f]{32})';

export function createGateway(options: GatewayOptions) {
  const { manager, runs, authenticate, audit, origin } = options;
  const quotas = options.quotas ?? DEFAULT_QUOTAS;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const now = options.now ?? Date.now;
  const startedAt = now();

  const routes: Route[] = [
    ['GET', /^\/api\/me$/, async ({ who }) => who],
    ['GET', /^\/api\/workspaces$/, async ({ who }) => manager.list(who.userId)],
    [
      'POST',
      /^\/api\/workspaces$/,
      async ({ req, who }) => {
        const { name } = parseBody(CreateWorkspace, await readJson(req));
        if ((await manager.list(who.userId)).length >= quotas.workspacesPerUser)
          throw new GatewayError('QUOTA_WORKSPACES');
        const workspace = await manager.create(who.userId, { name });
        audit({
          actor: who.userId,
          action: 'workspace.create',
          workspaceId: workspace.id,
          outcome: 'created',
        });
        return workspace;
      },
    ],
    [
      'GET',
      new RegExp(`^/api/workspaces/${WS}$`),
      async ({ who, params }) => manager.get(who.userId, params[0]),
    ],
    [
      'POST',
      new RegExp(`^/api/workspaces/${WS}/start$`),
      async ({ who, params }) => {
        const workspace = await manager.start(who.userId, params[0]);
        audit({
          actor: who.userId,
          action: 'workspace.start',
          workspaceId: params[0],
          outcome: workspace.state,
        });
        return workspace;
      },
    ],
    [
      'POST',
      new RegExp(`^/api/workspaces/${WS}/stop$`),
      async ({ who, params }) => {
        const workspace = await manager.stop(who.userId, params[0]);
        audit({
          actor: who.userId,
          action: 'workspace.stop',
          workspaceId: params[0],
          outcome: workspace.state,
        });
        return workspace;
      },
    ],
    [
      'GET',
      new RegExp(`^/api/workspaces/${WS}/conversations$`),
      async ({ who, params }) => manager.conversations(who.userId, params[0]),
    ],
    [
      'GET',
      new RegExp(`^/api/workspaces/${WS}/conversations/([A-Za-z0-9_-]{1,200})/messages$`),
      async ({ who, params }) => manager.messages(who.userId, params[0], params[1]),
    ],
    [
      'GET',
      new RegExp(`^/api/workspaces/${WS}/runs$`),
      async ({ who, params }) => runs.list(who.userId, params[0]),
    ],
    [
      'POST',
      new RegExp(`^/api/workspaces/${WS}/runs$`),
      async ({ req, res, who, params }) => {
        const input = parseBody(AskInput, await readJson(req));
        res.statusCode = 202;
        return runs.start(who.userId, params[0], input);
      },
    ],
    [
      'GET',
      new RegExp(`^/api/workspaces/${WS}/runs/${RUN}$`),
      async ({ who, params }) => runs.get(who.userId, params[0], params[1]),
    ],
    [
      'POST',
      new RegExp(`^/api/workspaces/${WS}/runs/${RUN}/cancel$`),
      async ({ who, params }) => runs.cancel(who.userId, params[0], params[1]),
    ],
    [
      'GET',
      /^\/api\/admin\/health$/,
      async ({ who }) => {
        if (!who.admin) throw new GatewayError('FORBIDDEN');
        // Counts only: no Workspace names, owners, prompts or answers.
        return {
          ok: true,
          uptimeSeconds: Math.round((now() - startedAt) / 1000),
          runtimes: manager.stats(),
          runs: runs.stats(),
          quotas,
        };
      },
    ],
  ];

  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(req.url ?? '/', 'http://gateway');
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
      const requestOrigin = req.headers.origin;
      if (requestOrigin !== undefined) {
        if (!origin || requestOrigin !== origin) throw new GatewayError('ORIGIN_DENIED');
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID');
        res.setHeader('Access-Control-Max-Age', '600');
        return send(res, 204);
      }
      const who = await authenticate(req.headers.authorization);
      if (!who) throw new GatewayError('UNAUTHENTICATED');

      const events = new RegExp(`^/api/workspaces/${WS}/events$`).exec(url.pathname);
      if (req.method === 'GET' && events) return await stream(req, res, who, events[1], url);

      for (const [method, pattern, handler] of routes) {
        const match = req.method === method ? pattern.exec(url.pathname) : null;
        if (!match) continue;
        const result = await handler({ req, res, who, params: match.slice(1) });
        return send(res, res.statusCode, result);
      }
      throw new GatewayError('NOT_FOUND');
    } catch (error) {
      const code =
        error instanceof WorkspaceError || error instanceof GatewayError ? error.code : codeOf(error);
      if (!res.headersSent) send(res, STATUS[code] ?? (code === 'RUN_FAILED' ? 500 : 502), { code });
      else res.end();
    }
  });

  /**
   * Server-sent events of one Workspace. A client that reconnects with Last-Event-ID gets what it missed; the run
   * itself never depends on this connection.
   */
  async function stream(
    req: IncomingMessage,
    res: ServerResponse,
    who: Identity,
    workspaceId: string,
    url: URL,
  ) {
    const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new WorkspaceError('INVALID_INPUT');
    const buffered: string[] = [];
    let open = false;
    const write = (chunk: string) => (open ? res.write(chunk) : buffered.push(chunk));
    const stop = await runs.follow(who.userId, workspaceId, after, (event) =>
      write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`),
    );
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    open = true;
    res.write(': connected\n\n' + buffered.join(''));
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), heartbeatMs);
    req.on('close', () => {
      clearInterval(heartbeat);
      stop();
    });
  }
}

function send(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage) {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new GatewayError('INVALID_JSON');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new GatewayError('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GatewayError('INVALID_JSON');
  }
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GatewayError('INVALID_INPUT');
  return result.data;
}
