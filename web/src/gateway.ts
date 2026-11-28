// Cloud Workspace mode (ADR 0001 phase 3b): the same screens, served by the Gateway instead of Supabase.
// Every call goes to the Gateway with the employee's Google ID token; the browser never reaches a runtime.
import type {
  ChatMessage,
  Conversation,
  DocumentRecord,
  Run,
  Skill,
  Snapshot,
  SourceRef,
  Workspace,
} from '../../packages/harness-core/src/contracts.ts';
import { ApiError, type Host } from './host.ts';
import type { Page } from './routes.ts';

export type GatewayConfig = { baseUrl: string; clientId: string };

/** Cloud Workspace mode is chosen at build time; without both values the app stays on Supabase. */
export function gatewayConfig(): GatewayConfig | null {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  const baseUrl = env.VITE_GATEWAY_URL;
  const clientId = env.VITE_GOOGLE_CLIENT_ID;
  return baseUrl && clientId ? { baseUrl: baseUrl.replace(/\/$/, ''), clientId } : null;
}

/**
 * Pages the Gateway can serve today. Memory, receipts, forms and Google come with the server's tool host
 * (ADR 0001 phases 4–5); until then they are hidden rather than shown broken.
 */
export const GATEWAY_PAGES: ReadonlySet<Page> = new Set(['chat', 'history', 'help', 'skills', 'documents']);

export const pageAvailable = (page: Page) => !gatewayConfig() || GATEWAY_PAGES.has(page);

/** Memory, attached documents and saved drafts are not in Cloud Workspace yet; their controls are hidden there. */
export const cloudMode = () => Boolean(gatewayConfig());

/** The one organization a Cloud Workspace user belongs to; the Gateway checks membership itself. */
export const CLOUD_TENANT = 'cloud';

const CREDENTIAL_KEY = 'step-gateway-credential';
const HOME_NAME = 'งานของฉัน';

/** The Google ID token for this tab, while it is still valid for at least a minute. */
export function storedCredential(now = Date.now()) {
  try {
    const token = sessionStorage.getItem(CREDENTIAL_KEY);
    if (!token) return null;
    const claims = credentialClaims(token);
    if (!claims || claims.exp * 1000 < now + 60_000) {
      sessionStorage.removeItem(CREDENTIAL_KEY);
      return null;
    }
    return { token, ...claims };
  } catch {
    return null;
  }
}

export function storeCredential(token: string) {
  if (!credentialClaims(token)) throw new ApiError('GOOGLE_LOGIN_FAILED');
  sessionStorage.setItem(CREDENTIAL_KEY, token);
}

export function clearCredential() {
  try {
    sessionStorage.removeItem(CREDENTIAL_KEY);
  } catch {
    // Storage blocked: nothing was kept.
  }
}

/** Reads, does not verify: the Gateway verifies the signature. Used only to show who is signed in and when it ends. */
export function credentialClaims(token: string): { sub: string; email: string; exp: number } | null {
  try {
    const body = token.split('.')[1];
    const claims = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
    return { sub: claims.sub, email: String(claims.email ?? ''), exp: claims.exp };
  } catch {
    return null;
  }
}

type GatewayWorkspace = { id: string; name: string; createdAt: string; state: string };
type GatewayRun = {
  id: string;
  workspaceId: string;
  sessionId: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  code?: string;
  startedAt: string;
};
type Finished = { answer?: string; sources: string[] };
type GatewayFile = { name: string; bytes: number; modifiedAt: string; mime: string };

export type GatewayHostOptions = GatewayConfig & {
  /** The current Google ID token, or null when the tab has none. */
  credential: () => string | null;
  /** Called when the Gateway no longer accepts the credential. */
  onUnauthorized?: () => void;
  fetch?: typeof fetch;
  /** Wait before reopening a dropped event stream. */
  reconnectMs?: number;
};

const STATUS: Record<GatewayRun['status'], Run['status']> = {
  running: 'running',
  done: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** Conversations are named `<workspace>.<session>` so one id finds both. */
const conversationId = (workspaceId: string, sessionId: string) => `${workspaceId}.${sessionId}`;
function splitConversation(id: unknown) {
  const match = /^(ws_[0-9a-f]{32})\.([A-Za-z0-9_-]{1,200})$/.exec(String(id));
  if (!match) throw new ApiError('ACCESS_DENIED');
  return { workspaceId: match[1], sessionId: match[2] };
}
const source = (label: string): SourceRef => ({
  id: label,
  title: label,
  location: '',
  kind: 'organization',
});

export function gatewayHost(options: GatewayHostOptions): Host {
  const http = options.fetch ?? fetch.bind(globalThis);
  const reconnectMs = options.reconnectMs ?? 2_000;
  /** Workspace of each run this tab knows about. */
  const runWorkspace = new Map<string, string>();
  const partial = new Map<string, string>();
  const finished = new Map<string, Finished>();
  const streams = new Map<string, AbortController>();
  /** Uploads begun with document.create: provisional path → where it goes, then the file as saved. */
  const pendingUploads = new Map<string, { workspaceId: string; name: string; saved?: DocumentRecord }>();
  /** The signed-in employee, as the Gateway sees them; the chat lets only a run's owner stop it. */
  let identity: Promise<{ userId: string; email: string; admin: boolean }> | undefined;
  const whoAmI = () => {
    identity ??= request<{ userId: string; email: string; admin: boolean }>('GET', '/api/me').catch(
      (error) => {
        identity = undefined;
        throw error;
      },
    );
    return identity;
  };

  /** One authenticated call; a refused credential signs the tab out, other refusals become the Gateway's code. */
  async function gatewayFetch(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: { json: unknown } | { file: Blob },
    timeoutMs = 25_000,
  ): Promise<Response> {
    const token = options.credential();
    if (!token) throw new ApiError('UNAUTHENTICATED');
    let response: Response;
    try {
      response = await http(options.baseUrl + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          ...(body && 'json' in body ? { 'Content-Type': 'application/json' } : {}),
          ...(body && 'file' in body ? { 'Content-Type': 'application/octet-stream' } : {}),
        },
        body: !body ? undefined : 'json' in body ? JSON.stringify(body.json) : body.file,
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ApiError('NETWORK_ERROR');
    }
    if (response.status === 401) {
      options.onUnauthorized?.();
      throw new ApiError('UNAUTHENTICATED');
    }
    if (!response.ok) {
      const result = await response.json().catch(() => ({ code: 'SERVER_ERROR' }));
      throw new ApiError(typeof result.code === 'string' ? result.code : 'SERVER_ERROR');
    }
    return response;
  }

  async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const response = await gatewayFetch(method, path, body === undefined ? undefined : { json: body });
    if (response.status === 204) return undefined as T;
    return (await response.json().catch(() => {
      throw new ApiError('SERVER_ERROR');
    })) as T;
  }

  /** The home Workspace's files as the Documents page lists them; ids and paths are `<workspace>/<file name>`. */
  function documentRecord(workspaceId: string, userId: string, file: GatewayFile): DocumentRecord {
    const id = `${workspaceId}/${encodeURIComponent(file.name)}`;
    return {
      id,
      tenant_id: CLOUD_TENANT,
      owner_id: userId,
      workspace_id: null,
      visibility: 'private',
      name: file.name,
      mime: file.mime.split(';')[0],
      bytes: file.bytes,
      source_kind: 'upload',
      drive_file_id: null,
      object_path: id,
      status: 'ready',
      error_code: null,
      created_at: file.modifiedAt,
    };
  }

  /** `<workspace>/<encoded name>` back to its parts, refusing anything else. */
  function splitDocument(value: unknown) {
    const match = /^(ws_[0-9a-f]{32})\/([^/]+)$/.exec(String(value ?? ''));
    if (!match) throw new ApiError('ACCESS_DENIED');
    return { workspaceId: match[1], encoded: match[2] };
  }

  /** Follows one Workspace's events while it has a run this tab is watching, resuming after a dropped connection. */
  function follow(workspaceId: string) {
    if (streams.has(workspaceId)) return;
    const controller = new AbortController();
    streams.set(workspaceId, controller);
    let lastId = 0;
    let failures = 0;
    const watching = () => [...runWorkspace].some(([run, ws]) => ws === workspaceId && !finished.has(run));
    void (async () => {
      while (!controller.signal.aborted && watching()) {
        try {
          const token = options.credential();
          if (!token) break;
          const response = await http(`${options.baseUrl}/api/workspaces/${workspaceId}/events`, {
            headers: { Authorization: 'Bearer ' + token, 'Last-Event-ID': String(lastId) },
            cache: 'no-store',
            signal: controller.signal,
          });
          if (response.status === 401) {
            options.onUnauthorized?.();
            break;
          }
          if (!response.ok || !response.body) throw new Error('STREAM');
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const field = (name: string) => new RegExp(`^${name}: (.*)$`, 'm').exec(block)?.[1];
              const type = field('event');
              if (!type) continue;
              lastId = Number(field('id')) || lastId;
              apply(type, JSON.parse(field('data') || '{}'));
            }
            if (!watching()) {
              await reader.cancel();
              break;
            }
          }
          failures = 0;
        } catch {
          if (controller.signal.aborted) break;
          failures++;
        }
        // A Gateway that keeps refusing the stream is retried less and less often, up to half a minute.
        if (watching())
          await new Promise((done) => setTimeout(done, Math.min(reconnectMs * 2 ** failures, 30_000)));
      }
      streams.delete(workspaceId);
    })();
  }

  function apply(type: string, data: any) {
    const runId = typeof data.runId === 'string' ? data.runId : typeof data.id === 'string' ? data.id : '';
    if (type === 'delta' && runId) partial.set(runId, (partial.get(runId) ?? '') + String(data.text ?? ''));
    else if (type === 'discard' && runId) {
      const text = partial.get(runId) ?? '';
      partial.set(runId, text.slice(0, Math.max(0, text.length - Number(data.count ?? 0))));
    } else if (type === 'run' && runId && data.status && data.status !== 'running')
      finished.set(runId, { answer: data.answer, sources: Array.isArray(data.sources) ? data.sources : [] });
    // A reset means older events are gone; finished results are read from the conversation instead.
    else if (type === 'reset') partial.clear();
  }

  async function toRun(run: GatewayRun, result: unknown = null): Promise<Run> {
    return {
      id: run.id,
      tenant_id: CLOUD_TENANT,
      actor_id: (await whoAmI()).userId,
      session_id: conversationId(run.workspaceId, run.sessionId),
      document_id: null,
      kind: 'chat',
      status: STATUS[run.status],
      error_code: run.code ?? null,
      partial: partial.get(run.id) ?? '',
      result,
      created_at: run.startedAt,
      document_tool: null,
    };
  }

  async function messages(workspaceId: string, sessionId: string): Promise<ChatMessage[]> {
    const rows = await request<{ role: 'user' | 'assistant'; text: string; at?: string }[]>(
      'GET',
      `/api/workspaces/${workspaceId}/conversations/${sessionId}/messages`,
    );
    return rows.map((m, index) => ({
      id: `${sessionId}:${index}`,
      role: m.role,
      body: m.text,
      sources: [],
      created_at: m.at ?? '',
    }));
  }

  async function snapshot(): Promise<Snapshot> {
    const me = await whoAmI();
    const [list, skills] = await Promise.all([
      request<GatewayWorkspace[]>('GET', '/api/workspaces'),
      request<Skill[]>('GET', '/api/skills'),
    ]);
    const home = list[0]?.id;
    const sessions: Conversation[] = [];
    for (const ws of list) {
      const conversations = await request<{ id: string; title: string; updatedAt?: string }[]>(
        'GET',
        `/api/workspaces/${ws.id}/conversations`,
      );
      for (const c of conversations)
        sessions.push({
          id: conversationId(ws.id, c.id),
          tenant_id: CLOUD_TENANT,
          owner_id: me.userId,
          // The first Workspace holds the tasks of the home screen; the rest are chosen in the Workspace switcher.
          workspace_id: ws.id === home ? null : ws.id,
          visibility: 'private',
          title: c.title || 'เริ่มงานใหม่',
          version: 1,
          draft: '',
          created_at: c.updatedAt ?? ws.createdAt,
        });
    }
    sessions.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return {
      user: { id: me.userId, email: me.email, name: me.email.split('@')[0] },
      tenants: [
        {
          id: CLOUD_TENANT,
          name: 'STeP Cloud Workspace',
          active: true,
          storage_limit: 0,
          member_storage_limit: 0,
          monthly_ai_budget_cents: 0,
          input_cents_per_million: null,
          output_cents_per_million: null,
        },
      ],
      memberships: [
        { tenant_id: CLOUD_TENANT, user_id: me.userId, role: 'member', active: true, email: me.email },
      ],
      workspaces: list
        .filter((ws) => ws.id !== home)
        .map((ws): Workspace => ({
          id: ws.id,
          tenant_id: CLOUD_TENANT,
          created_by: me.userId,
          name: ws.name,
          description: '',
        })),
      sessions,
      memories: [],
      documents: home
        ? (await request<GatewayFile[]>('GET', `/api/workspaces/${home}/files`)).map((file) =>
            documentRecord(home, me.userId, file),
          )
        : [],
      skills,
      profiles: [],
    };
  }

  async function homeWorkspace() {
    const list = await request<GatewayWorkspace[]>('GET', '/api/workspaces');
    return (
      list[0]?.id ?? (await request<GatewayWorkspace>('POST', '/api/workspaces', { name: HOME_NAME })).id
    );
  }

  return {
    demo: false,
    async signIn() {
      // Signing in happens in the Google button on the sign-in screen (see GoogleSignIn in App.tsx).
    },
    async signOut() {
      // Stops following runs; the runs themselves go on in their Workspaces.
      for (const controller of streams.values()) controller.abort();
      for (const map of [streams, runWorkspace, partial, finished]) map.clear();
      identity = undefined;
      clearCredential();
    },
    async upload(path: string, file: File) {
      const pending = pendingUploads.get(path);
      if (!pending) throw new ApiError('ACCESS_DENIED');
      const response = await gatewayFetch(
        'POST',
        `/api/workspaces/${pending.workspaceId}/files?name=${encodeURIComponent(pending.name)}`,
        { file },
        120_000,
      );
      const me = await whoAmI();
      pending.saved = documentRecord(pending.workspaceId, me.userId, (await response.json()) as GatewayFile);
    },
    async download(path: string) {
      const { workspaceId, encoded } = splitDocument(path);
      return (
        await gatewayFetch('GET', `/api/workspaces/${workspaceId}/files/${encoded}`, undefined, 120_000)
      ).blob();
    },
    async call<T>(action: string, input: Record<string, unknown> = {}): Promise<T> {
      const result = await (async (): Promise<unknown> => {
        switch (action) {
          case 'snapshot':
            return snapshot();
          case 'workspace.create': {
            const ws = await request<GatewayWorkspace>('POST', '/api/workspaces', {
              name: String(input.name ?? ''),
            });
            return { id: ws.id, tenant_id: CLOUD_TENANT, created_by: '', name: ws.name, description: '' };
          }
          case 'session.create': {
            const workspaceId = typeof input.workspace === 'string' ? input.workspace : await homeWorkspace();
            const { sessionId } = await request<{ sessionId: string }>(
              'POST',
              `/api/workspaces/${workspaceId}/conversations`,
            );
            const row: Conversation = {
              id: conversationId(workspaceId, sessionId),
              tenant_id: CLOUD_TENANT,
              owner_id: '',
              workspace_id: typeof input.workspace === 'string' ? workspaceId : null,
              visibility: 'private',
              title: String(input.title || 'เริ่มงานใหม่'),
              version: 1,
              draft: '',
              created_at: new Date().toISOString(),
            };
            return row;
          }
          case 'session.read': {
            const { workspaceId, sessionId } = splitConversation(input.id);
            const [rows, runs, list] = await Promise.all([
              messages(workspaceId, sessionId),
              request<GatewayRun[]>('GET', `/api/workspaces/${workspaceId}/runs`),
              request<GatewayWorkspace[]>('GET', '/api/workspaces'),
            ]);
            const mine = runs.filter((run) => run.sessionId === sessionId).reverse();
            for (const run of mine) runWorkspace.set(run.id, workspaceId);
            if (mine.some((run) => run.status === 'running')) follow(workspaceId);
            const conversations = await request<{ id: string; title: string }[]>(
              'GET',
              `/api/workspaces/${workspaceId}/conversations`,
            );
            return {
              session: {
                id: String(input.id),
                tenant_id: CLOUD_TENANT,
                owner_id: '',
                workspace_id: list[0]?.id === workspaceId ? null : workspaceId,
                visibility: 'private',
                title: conversations.find((c) => c.id === sessionId)?.title || 'เริ่มงานใหม่',
                version: 1,
                draft: '',
              } satisfies Conversation,
              messages: rows,
              runs: await Promise.all(mine.map((run) => toRun(run))),
            };
          }
          case 'session.search': {
            const query = String(input.query ?? '').toLowerCase();
            return (await snapshot()).sessions
              .filter((s) => s.title.toLowerCase().includes(query))
              .slice(0, 50);
          }
          case 'context.plan':
            // Only the request and STeP's own documents reach the AI: no memory, files or Google yet.
            return {
              provider: 'AI ขององค์กร ผ่าน STeP Cloud Workspace',
              providerConsent: 'cloud-workspace',
              documents: [],
              memories: [],
              google: false,
              profile: false,
            };
          case 'run.start': {
            const { workspaceId, sessionId } = splitConversation(input.session);
            const run = await request<GatewayRun>('POST', `/api/workspaces/${workspaceId}/runs`, {
              text: String(input.message ?? ''),
              sessionId,
              ...(typeof input.skill === 'string' && input.skill ? { skill: input.skill } : {}),
            });
            runWorkspace.set(run.id, workspaceId);
            follow(workspaceId);
            return toRun(run);
          }
          case 'document.create': {
            // Nothing is stored until the file itself arrives (upload); the Gateway names it safely then.
            const workspaceId = await homeWorkspace();
            const path = `pending:${crypto.randomUUID()}`;
            const name = String(input.name ?? '').slice(0, 400);
            pendingUploads.set(path, { workspaceId, name });
            const me = await whoAmI();
            return {
              ...documentRecord(workspaceId, me.userId, {
                name,
                bytes: Number(input.bytes) || 0,
                modifiedAt: new Date().toISOString(),
                mime: String(input.mime ?? ''),
              }),
              id: path,
              object_path: path,
              status: 'uploading',
            } satisfies DocumentRecord;
          }
          case 'document.commit': {
            const saved = pendingUploads.get(String(input.id))?.saved;
            if (!saved) throw new ApiError('UPLOAD_FAILED');
            pendingUploads.delete(String(input.id));
            return saved;
          }
          case 'document.delete': {
            const id = String(input.id ?? '');
            const pending = pendingUploads.get(id);
            if (pending) {
              pendingUploads.delete(id);
              if (!pending.saved) return { ok: true };
            }
            const { workspaceId, encoded } = splitDocument(pending?.saved?.id ?? id);
            await request('DELETE', `/api/workspaces/${workspaceId}/files/${encoded}`);
            return { ok: true };
          }
          case 'skill.read':
            return request<Skill>('GET', `/api/skills/${encodeURIComponent(String(input.key ?? ''))}`);
          case 'run.read': {
            const id = String(input.id);
            const workspaceId = runWorkspace.get(id);
            if (!workspaceId) throw new ApiError('ACCESS_DENIED');
            const run = await request<GatewayRun>('GET', `/api/workspaces/${workspaceId}/runs/${id}`);
            if (run.status === 'running') {
              follow(workspaceId);
              return toRun(run);
            }
            let done = finished.get(id);
            if (!done && run.status === 'done') {
              // The event was missed (another tab, a reset): the answer is the conversation's last reply.
              const last = (await messages(workspaceId, run.sessionId))
                .filter((m) => m.role === 'assistant')
                .at(-1);
              done = { answer: last?.body, sources: [] };
            }
            finished.set(id, done ?? { sources: [] });
            return toRun(
              run,
              run.status === 'done'
                ? { text: done?.answer ?? '', sources: (done?.sources ?? []).map(source) }
                : null,
            );
          }
          case 'run.cancel': {
            const id = String(input.id);
            const workspaceId = runWorkspace.get(id);
            if (!workspaceId) throw new ApiError('ACCESS_DENIED');
            await request('POST', `/api/workspaces/${workspaceId}/runs/${id}/cancel`);
            return { ok: true };
          }
          default:
            throw new ApiError('CLOUD_NOT_AVAILABLE');
        }
      })();
      return result as T;
    },
  };
}
