// The organization AI gateway: one OpenAI-compatible endpoint that STeP Desktop and the Cloud Workspace runtimes call
// instead of holding an OpenRouter key. The key stays on this server. Every request needs an invited organization
// Google account (or a runtime token issued for one); the gateway picks the real model from the settings file, forces
// Zero Data Retention, and stops a person, department or the whole organization at its monthly cap.
// Prompts and answers pass through in memory only: nothing here logs or stores their text.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Authenticator, Identity } from '../gateway/auth.ts';
import {
  departmentOf,
  UNASSIGNED,
  userCapUsd,
  defaultModel,
  type AiGatewayConfig,
  type AiModel,
} from './config.ts';
import type { InternalIdentity } from './internal-token.ts';
import { monthOf, type UsageEntry, type UsageLedger } from './ledger.ts';

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';
/** Desktop sends whole conversations plus page images of scanned PDFs. */
const BODY_LIMIT = 24 * 1024 * 1024;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
/** Fields a client may set; everything else (provider routing, plugins, transforms, models fallback) is ours. */
const PASS_THROUGH = [
  'messages',
  'stream',
  'temperature',
  'top_p',
  'stop',
  'seed',
  'response_format',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'reasoning',
] as const;

export type AiProxyOptions = {
  authenticate: Authenticator;
  /** Runtime tokens from the Cloud Workspace Gateway; checked against the invite list like a Google sign-in. */
  internal?: { verify(token: string): InternalIdentity | null };
  invited: () => Set<string> | Promise<Set<string>>;
  config: () => Promise<AiGatewayConfig>;
  ledger: UsageLedger;
  /**
   * The organization's OpenRouter key, never sent anywhere but OpenRouter. A function is asked on every request, so the
   * gateway can be installed before the key exists and starts answering once the key file is in place.
   */
  key: string | (() => Promise<string | undefined>);
  upstream?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Delays before asking OpenRouter for the cost of a request whose stream ended early (tests shorten them). */
  settleDelaysMs?: number[];
};

type Who = Identity;

class ProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly thai: string,
    readonly retryAfter?: number,
  ) {
    super(code);
  }
}

const usd = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

/** OpenRouter answers 404 when no provider meets the request's data rules, 429/5xx when providers are busy or down. */
const retryable = (status: number) => status === 404 || status === 408 || status === 429 || status >= 500;

/** True when any message holds a picture or a file part (OpenAI image_url, input_image, or OpenRouter file/PDF). */
function carriesAttachment(messages: unknown[]) {
  return messages.some(
    (m) =>
      Array.isArray((m as { content?: unknown })?.content) &&
      (m as { content: unknown[] }).content.some((part) =>
        ['image_url', 'input_image', 'file'].includes((part as { type?: unknown })?.type as string),
      ),
  );
}

export function createAiProxy(options: AiProxyOptions) {
  const upstream = (options.upstream ?? OPENROUTER_API).replace(/\/$/, '');
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const settleDelays = options.settleDelaysMs ?? [3_000, 10_000, 30_000];
  const active = new Map<string, number>();
  const keyOf = typeof options.key === 'string' ? async () => options.key as string : options.key;
  async function openRouterKey() {
    const key = await keyOf().catch(() => undefined);
    if (!key) throw new ProxyError(503, 'ai_not_ready', 'ระบบ AI ขององค์กรยังไม่เปิดใช้ แจ้งผู้ดูแล');
    return key;
  }

  async function identify(req: IncomingMessage): Promise<Who> {
    const header = req.headers.authorization;
    const bearer = /^Bearer (\S{1,20000})$/.exec(header ?? '')?.[1];
    if (bearer && options.internal && bearer.startsWith('stepint.')) {
      const who = options.internal.verify(bearer);
      if (who && (await options.invited()).has(who.email)) return { ...who, admin: false };
      throw new ProxyError(401, 'unauthenticated', 'ลงชื่อเข้าใช้ใหม่');
    }
    let who: Identity | null = null;
    try {
      who = await options.authenticate(header);
    } catch {
      throw new ProxyError(503, 'auth_unavailable', 'ตรวจบัญชี Google ไม่ได้ชั่วคราว ลองใหม่อีกครั้ง');
    }
    if (!who) throw new ProxyError(401, 'unauthenticated', 'ลงชื่อเข้าใช้ด้วยบัญชี Google ขององค์กรใหม่');
    return who;
  }

  async function settings() {
    try {
      return await options.config();
    } catch {
      throw new ProxyError(503, 'ai_config_invalid', 'ระบบ AI ขององค์กรยังตั้งค่าไม่ถูกต้อง แจ้งผู้ดูแล');
    }
  }

  /** Refuses before calling OpenRouter when the person, their department or the organization is at its cap. */
  async function admit(config: AiGatewayConfig, who: Who) {
    const totals = await options.ledger.totals(monthOf(now()));
    const department = departmentOf(config, who.email);
    if (totals.org.usd >= config.budget.orgMonthlyUsd)
      throw new ProxyError(429, 'quota_exceeded', 'งบ AI ขององค์กรเดือนนี้หมดแล้ว แจ้งผู้ดูแล');
    if (department && (totals.departments.get(department.id)?.usd ?? 0) >= department.monthlyUsd)
      throw new ProxyError(429, 'quota_exceeded', `งบ AI ของ${department.name}เดือนนี้หมดแล้ว`);
    if ((totals.users.get(who.userId)?.usd ?? 0) >= userCapUsd(config, who.email))
      throw new ProxyError(429, 'quota_exceeded', 'โควตา AI ของคุณเดือนนี้หมดแล้ว');
    if ((active.get(who.userId) ?? 0) >= config.budget.userConcurrency)
      throw new ProxyError(429, 'too_many_requests', 'มีงานที่กำลังทำอยู่หลายงาน รอสักครู่', 5);
    return department?.id ?? UNASSIGNED.id;
  }

  function upstreamBody(input: Record<string, unknown>, model: AiModel, config: AiGatewayConfig, who: Who) {
    const body: Record<string, unknown> = {};
    for (const field of PASS_THROUGH) if (input[field] !== undefined) body[field] = input[field];
    const asked = [input.max_tokens, input.max_completion_tokens].find((n) => Number.isSafeInteger(n)) as
      number | undefined;
    body.model = model.upstream;
    body.max_tokens = Math.max(1, Math.min(asked ?? model.maxOutputTokens, model.maxOutputTokens));
    if (body.stream === true) body.stream_options = { include_usage: true };
    body.usage = { include: true };
    // Zero Data Retention and no training on our prompts, on every request, whatever the account settings are.
    const providers = model.providers ?? config.providers;
    body.provider = {
      zdr: true,
      data_collection: 'deny',
      ...(providers?.length ? { only: providers } : {}),
      ...(model.quantizations ? { quantizations: model.quantizations } : {}),
    };
    // A stable pseudonym lets OpenRouter tell people apart for abuse limits without learning who they are.
    body.user = createHash('sha256').update(`step:${who.userId}`).digest('hex').slice(0, 32);
    return body;
  }

  /** After a stream ends early OpenRouter has still billed what it generated; ask for the figure, else estimate. */
  async function settle(
    generationId: string | undefined,
    model: AiModel,
    estimateTokens: number,
  ): Promise<Cost> {
    if (generationId && /^[\w-]{1,120}$/.test(generationId)) {
      for (const delay of settleDelays) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        try {
          const response = await request(`${upstream}/generation?id=${encodeURIComponent(generationId)}`, {
            headers: { authorization: `Bearer ${await openRouterKey()}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            await response.body?.cancel();
            continue;
          }
          const data = ((await response.json()) as any)?.data;
          if (typeof data?.total_cost === 'number')
            return {
              inputTokens: Number(data.tokens_prompt) || 0,
              outputTokens: Number(data.tokens_completion) || 0,
              cachedTokens: 0,
              costUsd: usd(data.total_cost),
              costSource: 'provider' as const,
            };
        } catch {
          // try again after the next delay
        }
      }
    }
    return costOf(model, { prompt_tokens: estimateTokens, completion_tokens: 0 });
  }

  async function chat(req: IncomingMessage, res: ServerResponse, who: Who) {
    const config = await settings();
    const input = await readJson(req);
    const asked = config.models.find((m) => m.id === input.model);
    if (!asked) throw new ProxyError(400, 'model_not_allowed', 'องค์กรไม่ได้เปิดโมเดลนี้');
    if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 1_000)
      throw new ProxyError(400, 'invalid_request', 'คำขอไม่ถูกต้อง');
    await openRouterKey();
    const department = await admit(config, who);
    // Task-based routing: a picture or PDF sent to the default model goes to the model set for reading them.
    const imageModel = config.models.find((m) => m.id === config.routes.images);
    const first =
      imageModel && asked === defaultModel(config) && carriesAttachment(input.messages) ? imageModel : asked;
    active.set(who.userId, (active.get(who.userId) ?? 0) + 1);
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on('close', onClose);
    try {
      let model = first;
      for (let attempt = 0; ; attempt++) {
        const response = await callUpstream(input, model, config, who, abort.signal);
        if (!response) return;
        const record = recorder(who, department, model);
        if (!response.ok) {
          const reason = await upstreamError(response);
          console.error('ai upstream', response.status, reason.code, model.id);
          await record('error', costOf(model, {}));
          const fallback = config.models.find((m) => m.id === model.fallback);
          // Providers down, overloaded or none left under our data rules: try the stand-in once.
          if (fallback && attempt === 0 && retryable(response.status) && !abort.signal.aborted) {
            model = fallback;
            continue;
          }
          throw mapUpstream(response, reason.contextTooLong);
        }
        const body = upstreamBody(input, model, config, who);
        // Rough size of the prompt in tokens, only for estimating a request OpenRouter never reported on.
        const estimateTokens = Math.ceil(JSON.stringify(body).length / 3);
        if (input.stream === true)
          await stream(response, res, abort.signal, model, record, estimateTokens, settle);
        else {
          const text = await readLimited(response, RESPONSE_LIMIT);
          let data: any;
          try {
            data = JSON.parse(text);
          } catch {
            throw new ProxyError(502, 'upstream_invalid', 'ผู้ให้บริการ AI ตอบกลับผิดรูปแบบ');
          }
          await record('ok', costOf(model, data?.usage));
          send(res, 200, data);
        }
        return;
      }
    } finally {
      res.off('close', onClose);
      const left = (active.get(who.userId) ?? 1) - 1;
      if (left > 0) active.set(who.userId, left);
      else active.delete(who.userId);
    }
  }

  function recorder(who: Who, department: string, model: AiModel) {
    const base = {
      userId: who.userId,
      email: who.email,
      department,
      model: model.id,
      upstream: model.upstream,
    };
    return (outcome: UsageEntry['outcome'], cost: Cost) =>
      options.ledger.record({ at: new Date(now()).toISOString(), ...base, ...cost, outcome }).catch(() => {});
  }

  /** Undefined when the employee went away before OpenRouter answered. */
  async function callUpstream(
    input: Record<string, unknown>,
    model: AiModel,
    config: AiGatewayConfig,
    who: Who,
    signal: AbortSignal,
  ): Promise<Response | undefined> {
    const key = await openRouterKey();
    try {
      return await request(`${upstream}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'x-title': 'STeP AI',
        },
        body: JSON.stringify(upstreamBody(input, model, config, who)),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(900_000)]),
      });
    } catch {
      if (signal.aborted) return undefined;
      throw new ProxyError(502, 'upstream_unreachable', 'ติดต่อผู้ให้บริการ AI ไม่ได้ ลองใหม่อีกครั้ง');
    }
  }

  async function usageOf(config: AiGatewayConfig, who: Who) {
    const month = monthOf(now());
    const totals = await options.ledger.totals(month);
    const mine = totals.users.get(who.userId);
    const cap = userCapUsd(config, who.email);
    return {
      month,
      spentUsd: usd(mine?.usd ?? 0),
      capUsd: cap,
      requests: mine?.requests ?? 0,
      ...(config.budget.thbPerUsd
        ? {
            thbPerUsd: config.budget.thbPerUsd,
            spentThb: Math.round((mine?.usd ?? 0) * config.budget.thbPerUsd),
          }
        : {}),
    };
  }

  async function report(config: AiGatewayConfig, month: string) {
    const totals = await options.ledger.totals(month);
    const thb = (n: number) =>
      config.budget.thbPerUsd ? Math.round(n * config.budget.thbPerUsd) : undefined;
    const names = new Map<string, string>([
      [UNASSIGNED.id, UNASSIGNED.name],
      ...config.departments.map((d) => [d.id, d.name] as [string, string]),
    ]);
    return {
      month,
      org: {
        spentUsd: usd(totals.org.usd),
        capUsd: config.budget.orgMonthlyUsd,
        spentThb: thb(totals.org.usd),
        requests: totals.org.requests,
      },
      departments: [...totals.departments].map(([id, t]) => ({
        id,
        name: names.get(id) ?? id,
        spentUsd: usd(t.usd),
        spentThb: thb(t.usd),
        capUsd: config.departments.find((d) => d.id === id)?.monthlyUsd,
        requests: t.requests,
      })),
      users: [...totals.users.values()]
        .sort((a, b) => b.usd - a.usd)
        .map((u) => ({
          email: u.email,
          department: names.get(u.department) ?? u.department,
          spentUsd: usd(u.usd),
          spentThb: thb(u.usd),
          capUsd: userCapUsd(config, u.email),
          requests: u.requests,
        })),
    };
  }

  return createServer(async (req, res) => {
    try {
      // Desktop and the runtimes call from Node, never from a web page; a browser origin is not a client here.
      if (req.headers.origin) throw new ProxyError(403, 'origin_denied', 'ไม่อนุญาต');
      const url = new URL(req.url ?? '/', 'http://localhost');
      // Served either at the root or under /ai when it shares a host name with the web app.
      const path = url.pathname.replace(/^\/ai(?=\/)/, '');
      if (req.method === 'GET' && path === '/healthz')
        return send(res, 200, { ok: true, ready: Boolean(await keyOf().catch(() => undefined)) });
      const who = await identify(req);
      if (req.method === 'GET' && path === '/v1/models') {
        const config = await settings();
        const first = defaultModel(config);
        const models = [first, ...config.models.filter((m) => m !== first)];
        return send(res, 200, {
          object: 'list',
          data: models.map((m) => ({ id: m.id, name: m.label, object: 'model', owned_by: 'step' })),
        });
      }
      if (req.method === 'POST' && path === '/v1/chat/completions') return await chat(req, res, who);
      if (req.method === 'GET' && path === '/v1/usage')
        return send(res, 200, await usageOf(await settings(), who));
      if (req.method === 'GET' && path === '/v1/admin/usage') {
        if (!who.admin) throw new ProxyError(403, 'forbidden', 'เฉพาะผู้ดูแล');
        const month = url.searchParams.get('month') ?? monthOf(now());
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
          throw new ProxyError(400, 'invalid_request', 'เดือนไม่ถูกต้อง');
        return send(res, 200, await report(await settings(), month));
      }
      throw new ProxyError(404, 'not_found', 'ไม่พบ');
    } catch (error) {
      const e =
        error instanceof ProxyError
          ? error
          : error instanceof Error && error.message === 'BODY_TOO_LARGE'
            ? new ProxyError(413, 'request_too_large', 'คำขอใหญ่เกินไป')
            : error instanceof Error && error.message === 'INVALID_JSON'
              ? new ProxyError(400, 'invalid_request', 'คำขอไม่ถูกต้อง')
              : new ProxyError(500, 'internal_error', 'เกิดข้อผิดพลาดในระบบ AI ขององค์กร');
      if (e.status === 500) console.error('ai gateway', error instanceof Error ? error.name : 'error');
      if (res.headersSent) return void res.end();
      if (e.retryAfter) res.setHeader('retry-after', String(e.retryAfter));
      send(res, e.status, { error: { code: e.code, type: e.code, message: e.thai } });
    }
  });
}

async function stream(
  response: Response,
  res: ServerResponse,
  signal: AbortSignal,
  model: AiModel,
  record: (outcome: UsageEntry['outcome'], cost: Cost) => Promise<void>,
  estimateTokens: number,
  settle: (id: string | undefined, model: AiModel, estimate: number) => Promise<Cost>,
) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  let usage: unknown;
  let generationId: string | undefined;
  let pending = '';
  const decoder = new TextDecoder();
  const reader = response.body!.getReader();
  // Watch the events go by for the final usage figure; the bytes reach the client unchanged.
  const watch = (text: string) => {
    pending += text;
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]' || !data.startsWith('{')) continue;
      try {
        const event = JSON.parse(data);
        if (typeof event.id === 'string') generationId ??= event.id;
        if (event.usage) usage = event.usage;
      } catch {
        // not ours to judge; the client parses the stream
      }
    }
    if (pending.length > 1_000_000) pending = '';
  };
  let finished = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      watch(decoder.decode(chunk.value, { stream: true }));
      if (!res.write(chunk.value)) await new Promise((resolve) => res.once('drain', resolve));
    }
    finished = true;
  } catch {
    // the client went away or the upstream stream broke
  } finally {
    await reader.cancel().catch(() => {});
    res.end();
  }
  // Recording happens after the response has ended so a slow cost lookup never holds the client.
  const outcome = signal.aborted ? 'cancelled' : finished ? 'ok' : 'error';
  void (usage ? Promise.resolve(costOf(model, usage)) : settle(generationId, model, estimateTokens)).then(
    (cost) => record(outcome, cost),
  );
}

type Cost = Pick<UsageEntry, 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'costUsd' | 'costSource'>;

function costOf(model: AiModel, usage: any): Cost {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const inputTokens = n(usage?.prompt_tokens);
  const outputTokens = n(usage?.completion_tokens);
  const cachedTokens = n(usage?.prompt_tokens_details?.cached_tokens);
  const provider = typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0;
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    costUsd: usd(
      provider ? usage.cost : (inputTokens * model.price.input + outputTokens * model.price.output) / 1e6,
    ),
    costSource: provider ? 'provider' : 'price',
  } satisfies Cost;
}

function mapUpstream(response: Response, contextTooLong: boolean) {
  const retry = Number(response.headers.get('retry-after'));
  switch (response.status) {
    case 400:
    case 413:
      return contextTooLong
        ? new ProxyError(400, 'context_length_exceeded', 'ข้อความยาวเกินกว่าที่โมเดลรับได้')
        : new ProxyError(400, 'invalid_request', 'ผู้ให้บริการ AI ไม่รับคำขอนี้');
    case 402:
      return new ProxyError(429, 'credit_balance_exhausted', 'เครดิต AI ขององค์กรหมด แจ้งผู้ดูแลเติมเครดิต');
    case 403:
      return new ProxyError(429, 'quota_exceeded', 'ผู้ให้บริการ AI ปฏิเสธคำขอตามข้อจำกัดขององค์กร');
    case 429:
      return new ProxyError(
        429,
        'rate_limited',
        'ผู้ให้บริการ AI ใช้งานหนาแน่น ลองใหม่อีกครั้ง',
        retry > 0 ? retry : 10,
      );
    default:
      // 401 here means the organization's key is wrong or revoked: not something the employee can fix by signing in.
      return new ProxyError(502, 'upstream_failed', 'ผู้ให้บริการ AI ขัดข้อง ลองใหม่อีกครั้ง');
  }
}

/**
 * Only the structured code of an upstream error is kept for the log; its message may echo the prompt, so it is read
 * for one fact (the prompt was too long) and dropped.
 */
async function upstreamError(response: Response) {
  try {
    const data = JSON.parse(await readLimited(response, 16_384));
    const code = data?.error?.code ?? data?.error?.type;
    const message = typeof data?.error?.message === 'string' ? data.error.message : '';
    return {
      code: typeof code === 'string' || typeof code === 'number' ? String(code).slice(0, 60) : '',
      contextTooLong:
        /context.{0,20}(length|window)|too long|maximum.{0,20}tokens/i.test(message) ||
        /context_length/.test(String(code)),
    };
  } catch {
    return { code: '', contextTooLong: false };
  }
}

async function readLimited(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new ProxyError(502, 'upstream_invalid', 'ผู้ให้บริการ AI ตอบกลับใหญ่เกินไป');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (Number(req.headers['content-length'] ?? 0) > BODY_LIMIT) throw new Error('BODY_TOO_LARGE');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error('INVALID_JSON');
  }
}

function send(res: ServerResponse, status: number, value: unknown) {
  if (res.headersSent) return void res.end();
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}
