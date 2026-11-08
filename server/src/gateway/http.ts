// The Gateway's HTTP surface (ADR 0001 §3). The browser reaches Workspaces only through these routes: no runtime
// port, IPC channel, Docker socket or SQLite file is ever exposed. Every route but /healthz needs an invited
// identity, and a Workspace or run is found only under its owner.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { AskInput, WorkspaceError, WorkspaceName } from '../workspace/contract.ts';
import type { RuntimeManager } from '../workspace/manager.ts';
import type { Audit } from './audit.ts';
import { credentialStillValid, identityExpired, type Authenticator, type Identity } from './auth.ts';
import type { InvitationStore } from './invitation-store.ts';
import {
  codeOf,
  DEFAULT_QUOTAS,
  GatewayError,
  STREAM_PENDING_LIMIT,
  type Quotas,
  type RunService,
} from './runs.ts';
import { storageStatus, type StorageUsageSource } from './storage-usage.ts';

export type GatewayOptions = {
  manager: RuntimeManager;
  runs: RunService;
  authenticate: Authenticator;
  audit: Audit;
  /** The web app's origin; requests from any other browser origin are refused. */
  origin?: string;
  quotas?: Quotas;
  invitations?: InvitationStore;
  baseInvitations?: () => Set<string> | Promise<Set<string>>;
  heartbeatMs?: number;
  now?: () => number;
  /** Per-user pool usage for warnings and the early full-pool refusal; absent means 'unavailable'. */
  storageUsage?: StorageUsageSource;
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
  STORAGE_FULL: 507,
  QUOTA_WORKSPACES: 429,
  QUOTA_ACTIVE_RUNS: 429,
  QUOTA_DAILY_RUNS: 429,
  RUNTIME_CAPACITY: 503,
  RUNTIME_RECOVERY_PENDING: 503,
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
  if (quotas.workspacesPerUser !== manager.workspacesPerUser) throw new Error('QUOTA_POLICY_MISMATCH');
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const now = options.now ?? Date.now;
  const startedAt = now();

  const dispatch = <T>(who: Identity, send: () => T): T => {
    const admit = () => {
      if (identityExpired(who, now()) || !credentialStillValid(who))
        throw new GatewayError('UNAUTHENTICATED');
      return send();
    };
    return options.invitations ? options.invitations.dispatch(who.email, admit) : admit();
  };

  /** New saves are refused before any work once the caller's pool is full. Reading, starting, stopping and
   * cancelling are never refused here, so existing work stays reachable. */
  const refuseWhenFull = async (who: Identity) => {
    const status = await storageStatus(options.storageUsage, who.userId);
    if (status.state === 'available' && status.level === 'full') throw new GatewayError('STORAGE_FULL');
  };

  const startAuthority = (req: IncomingMessage, who: Identity) => ({
    authorize: async () => {
      const current = await authenticate(req.headers.authorization);
      if (!current || current.userId !== who.userId || current.email !== who.email)
        throw new GatewayError('UNAUTHENTICATED');
    },
    admit: (spawn: () => void) => dispatch(who, spawn),
  });

  const routes: Route[] = [
    ['GET', /^\/api\/me$/, async ({ who }) => who],
    // Only the caller's own pool: the owner comes from the verified identity, never from the request.
    ['GET', /^\/api\/storage$/, async ({ who }) => storageStatus(options.storageUsage, who.userId)],
    ['GET', /^\/api\/workspaces$/, async ({ who }) => manager.list(who.userId)],
    [
      'POST',
      /^\/api\/workspaces$/,
      async ({ req, who }) => {
        const { name } = parseBody(CreateWorkspace, await readJson(req));
        await refuseWhenFull(who);
        const workspace = await manager.create(who.userId, { name }, (publish) => dispatch(who, publish));
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
      async ({ req, who, params }) => {
        const authority = startAuthority(req, who);
        const workspace = await manager.start(who.userId, params[0], authority.admit, authority.authorize);
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
      async ({ req, who, params }) => {
        const workspace = await manager.stop(
          who.userId,
          params[0],
          (signal) => dispatch(who, signal),
          async () => {
            const current = await authenticate(req.headers.authorization);
            if (!current || current.userId !== who.userId || current.email !== who.email)
              throw new GatewayError('UNAUTHENTICATED');
          },
        );
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
      'POST',
      new RegExp(`^/api/workspaces/${WS}/conversations$`),
      async ({ req, who, params }) => {
        await refuseWhenFull(who);
        const conversation = await manager.newConversation(
          who.userId,
          params[0],
          (send) => dispatch(who, send),
          startAuthority(req, who),
        );
        audit({
          actor: who.userId,
          action: 'conversation.create',
          workspaceId: params[0],
          outcome: 'created',
        });
        return conversation;
      },
    ],
    [
      'GET',
      new RegExp(`^/api/workspaces/${WS}/conversations/([A-Za-z0-9_-]{1,200})/messages$`),
      async ({ req, who, params }) =>
        manager.messages(who.userId, params[0], params[1], startAuthority(req, who)),
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
        await refuseWhenFull(who);
        res.statusCode = 202;
        return runs.start(
          who.userId,
          params[0],
          input,
          async () => {
            const current = await authenticate(req.headers.authorization);
            if (!current || current.userId !== who.userId || current.email !== who.email)
              throw new GatewayError('UNAUTHENTICATED');
          },
          (send) => dispatch(who, send),
          (send) => dispatch(who, send),
          startAuthority(req, who),
        );
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
      async ({ who, params }) => runs.cancel(who.userId, params[0], params[1], (send) => dispatch(who, send)),
    ],
    [
      'GET',
      /^\/api\/admin\/invitations$/,
      async ({ who }) => {
        if (!who.admin) throw new GatewayError('FORBIDDEN');
        if (!options.invitations || !options.baseInvitations) throw new GatewayError('NOT_FOUND');
        const emails = options.invitations.invited(await options.baseInvitations());
        if (!emails.has(who.email)) throw new GatewayError('FORBIDDEN');
        return { emails: [...emails].sort() };
      },
    ],
    ...(
      [
        ['/api/admin/invitations', true],
        ['/api/admin/invitations/revoke', false],
      ] as const
    ).map(([path, active]): Route => [
      'POST',
      new RegExp(`^${path}$`),
      async ({ req, who }) => {
        if (!who.admin) throw new GatewayError('FORBIDDEN');
        if (!options.invitations || !options.baseInvitations) throw new GatewayError('NOT_FOUND');
        const { email } = parseBody(z.object({ email: z.string() }).strict(), await readJson(req));
        options.invitations.change(who.email, email, active, await options.baseInvitations(), () => {
          if (identityExpired(who, now()) || !credentialStillValid(who))
            throw new GatewayError('UNAUTHENTICATED');
        });
        audit({
          actor: who.userId,
          action: active ? 'invitation.create' : 'invitation.revoke',
          outcome: 'updated',
        });
        return { ok: true };
      },
    ]),
    [
      'GET',
      /^\/api\/admin\/health$/,
      async ({ who }) => {
        if (!who.admin) throw new GatewayError('FORBIDDEN');
        // Counts only: no Workspace names, owners, prompts or answers.
        return {
          ok: true,
          uptimeSeconds: Math.round((now() - startedAt) / 1000),
          metricsScope: { processLocal: true, resetOnRestart: true, dailyCountersResetAt: 'UTC midnight' },
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
        const current = await authenticate(req.headers.authorization);
        if (!current || current.userId !== who.userId || current.email !== who.email)
          throw new GatewayError('UNAUTHENTICATED');
        const body = result === undefined ? undefined : JSON.stringify(result);
        const deliver = () => sendEncoded(res, res.statusCode, body);
        return dispatch(who, deliver);
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
    let closed = false;
    let stop: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      stop?.();
      res.end();
    };
    req.on('close', close);
    let ready!: () => void;
    const opened = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let pending = Promise.resolve();
    let queued = 0;
    try {
      stop = await runs.follow(who.userId, workspaceId, after, (event) => {
        if (closed) return;
        if (++queued > STREAM_PENDING_LIMIT) return close();
        pending = pending
          .then(async () => {
            await opened;
            if (closed) return;
            const current = await authenticate(req.headers.authorization);
            if (closed) return;
            if (!current || current.userId !== who.userId || current.email !== who.email) return close();
            const frame = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
            const write = () => res.write(frame);
            const accepted = dispatch(who, write);
            if (!accepted) close();
          })
          .catch(close)
          .finally(() => {
            queued--;
          });
      });
      if (closed) {
        stop();
        return;
      }
      const current = await authenticate(req.headers.authorization);
      if (closed) return;
      if (!current || current.userId !== who.userId || current.email !== who.email) {
        close();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
      if (!res.write(': connected\n\n')) return close();
      heartbeat = setInterval(() => {
        if (!res.write(': heartbeat\n\n')) close();
      }, heartbeatMs);
    } finally {
      ready();
    }
  }
}

function send(res: ServerResponse, status: number, body?: unknown) {
  return sendEncoded(res, status, body === undefined ? undefined : JSON.stringify(body));
}

function sendEncoded(res: ServerResponse, status: number, body?: string) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(body);
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
