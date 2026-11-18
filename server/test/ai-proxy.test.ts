import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Authenticator } from '../src/gateway/auth.ts';
import { AiGatewayConfig, configFile } from '../src/ai-proxy/config.ts';
import { internalTokens } from '../src/ai-proxy/internal-token.ts';
import { monthOf, UsageLedger } from '../src/ai-proxy/ledger.ts';
import { createAiProxy } from '../src/ai-proxy/proxy.ts';

// Synthetic people, departments and a fake OpenRouter; nothing leaves the machine.
const NOW = Date.UTC(2026, 10, 18, 6, 0, 0);
const KEY = 'sk-or-v1-synthetic-organization-key';
const STAFF = { userId: 'g1001', email: 'staff@step.example', admin: false };
const OTHER = { userId: 'g1002', email: 'other@step.example', admin: false };
const ADMIN = { userId: 'g1003', email: 'admin@step.example', admin: true };
const people: Record<string, typeof STAFF> = { staff: STAFF, other: OTHER, admin: ADMIN };

const SETTINGS = AiGatewayConfig.parse({
  models: [
    {
      id: 'step-long',
      label: 'งานยาว',
      upstream: 'anthropic/claude-sonnet-5.5',
      price: { input: 2, output: 10 },
      maxOutputTokens: 32000,
    },
    {
      id: 'step-chat',
      label: 'งานทั่วไป',
      upstream: 'anthropic/claude-haiku-5.5',
      price: { input: 0.1, output: 0.5 },
      maxOutputTokens: 8192,
      default: true,
    },
  ],
  providers: ['google-vertex', 'amazon-bedrock'],
  budget: { orgMonthlyUsd: 100, userMonthlyUsd: 3, thbPerUsd: 33 },
  departments: [
    { id: 'it', name: 'งานไอที', monthlyUsd: 10, userMonthlyUsd: 5, members: ['staff@step.example'] },
  ],
});

const authenticate: Authenticator = async (header) =>
  people[/^Bearer (\w+)$/.exec(header ?? '')?.[1] ?? ''] ?? null;

type Seen = { path: string; authorization?: string; body: any };

async function fakeOpenRouter(reply: (seen: Seen, res: import('node:http').ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const entry = {
      path: req.url ?? '',
      authorization: req.headers.authorization,
      body: text ? JSON.parse(text) : undefined,
    };
    seen.push(entry);
    reply(entry, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const streamReply =
  (cost = 0.0123) =>
  (seen: Seen, res: import('node:http').ServerResponse) => {
    if (seen.path.startsWith('/generation')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({ data: { total_cost: 0.0042, tokens_prompt: 900, tokens_completion: 12 } }),
      );
    }
    if (!seen.body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          id: 'gen-1',
          choices: [{ message: { role: 'assistant', content: 'สวัสดี' } }],
          usage: { prompt_tokens: 1000, completion_tokens: 20, cost },
        }),
      );
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': OPENROUTER PROCESSING\n\n');
    res.write(`data: ${JSON.stringify({ id: 'gen-2', choices: [{ delta: { content: 'สวัส' } }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({ id: 'gen-2', choices: [{ delta: { content: 'ดี' }, finish_reason: 'stop' }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: 'gen-2', choices: [], usage: { prompt_tokens: 2000, completion_tokens: 40, cost } })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  };

async function setup(reply = streamReply(), options: { settings?: unknown; internalSecret?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-proxy-'));
  const settingsPath = join(dir, 'ai-gateway.json');
  await writeFile(settingsPath, JSON.stringify(options.settings ?? SETTINGS));
  const upstream = await fakeOpenRouter(reply);
  const invited = new Set(Object.values(people).map((p) => p.email));
  const ledger = new UsageLedger(dir);
  const internal = options.internalSecret ? internalTokens(options.internalSecret, () => NOW) : undefined;
  const proxy = createAiProxy({
    key: KEY,
    authenticate,
    invited: () => invited,
    config: configFile(settingsPath),
    ledger,
    upstream: upstream.url,
    now: () => NOW,
    settleDelaysMs: [10],
    ...(internal ? { internal } : {}),
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const call = (path: string, who: string | undefined, body?: unknown, init: RequestInit = {}) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      ...init,
      headers: {
        ...(who ? { authorization: `Bearer ${who}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers as Record<string, string> | undefined),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const close = async () => {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => (upstream.server as Server).close(resolve));
    await rm(dir, { recursive: true, force: true });
  };
  return { dir, settingsPath, upstream, ledger, invited, internal, call, close };
}

const ask = (model = 'step-chat', extra: Record<string, unknown> = {}) => ({
  model,
  stream: true,
  messages: [
    { role: 'system', content: 'ตอบเป็นภาษาไทย' },
    { role: 'user', content: 'สวัสดี' },
  ],
  ...extra,
});

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

test('staff see the organization models by their STeP names, default first, never the upstream ids', async () => {
  const t = await setup();
  try {
    const response = await t.call('/v1/models', 'staff');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      body.data.map((m: any) => [m.id, m.name]),
      [
        ['step-chat', 'งานทั่วไป'],
        ['step-long', 'งานยาว'],
      ],
    );
    assert.doesNotMatch(JSON.stringify(body), /anthropic|sonnet|haiku/);
    // Also served under /ai for a shared host name.
    assert.equal((await t.call('/ai/v1/models', 'staff')).status, 200);
  } finally {
    await t.close();
  }
});

test('a streamed answer passes through unchanged and the organization key, model, ZDR and caps are applied upstream', async () => {
  const t = await setup();
  try {
    const response = await t.call(
      '/v1/chat/completions',
      'staff',
      ask('step-chat', {
        max_tokens: 50_000,
        provider: { zdr: false },
        models: ['openai/gpt-x'],
        plugins: [{ id: 'web' }],
      }),
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /สวัส/);
    assert.match(text, /\[DONE\]/);
    const sent = t.upstream.seen[0];
    assert.equal(sent.path, '/chat/completions');
    assert.equal(sent.authorization, `Bearer ${KEY}`);
    assert.equal(sent.body.model, 'anthropic/claude-haiku-5.5');
    assert.equal(sent.body.max_tokens, 8192, 'clamped to the model cap');
    assert.deepEqual(sent.body.provider, {
      zdr: true,
      data_collection: 'deny',
      only: ['google-vertex', 'amazon-bedrock'],
    });
    assert.equal(sent.body.models, undefined, 'a client cannot add fallback models');
    assert.equal(sent.body.plugins, undefined, 'a client cannot turn on web plugins');
    assert.deepEqual(sent.body.stream_options, { include_usage: true });
    assert.match(sent.body.user, /^[0-9a-f]{32}$/);
    assert.doesNotMatch(JSON.stringify(sent.body), /staff@|g1001/);

    const totals = await until(
      () => t.ledger.totals(monthOf(NOW)),
      (v) => v.org.requests === 1,
    );
    assert.equal(totals.org.usd, 0.0123);
    assert.equal(totals.departments.get('it')?.usd, 0.0123);
    const line = JSON.parse(
      (await readFile(join(t.dir, 'ai-usage', `${monthOf(NOW)}.jsonl`), 'utf8')).trim(),
    );
    assert.equal(line.email, 'staff@step.example');
    assert.equal(line.inputTokens, 2000);
    assert.equal(line.costSource, 'provider');
    assert.doesNotMatch(JSON.stringify(line), /สวัส|ตอบเป็น/, 'no prompt or answer text in the usage file');
  } finally {
    await t.close();
  }
});

test('a non-streamed answer is recorded too, and a missing cost is estimated from the price list', async () => {
  const t = await setup((seen, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
      }),
    );
  });
  try {
    const response = await t.call('/v1/chat/completions', 'other', ask('step-long', { stream: false }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, 'ok');
    const totals = await t.ledger.totals(monthOf(NOW));
    assert.equal(totals.users.get('g1002')?.usd, 2, '1M input tokens at $2');
    assert.ok(totals.departments.has('unassigned'));
  } finally {
    await t.close();
  }
});

test('people without an organization sign-in, or asking for another model, are refused before OpenRouter is called', async () => {
  const t = await setup();
  try {
    assert.equal((await t.call('/v1/chat/completions', undefined, ask())).status, 401);
    assert.equal((await t.call('/v1/chat/completions', 'stranger', ask())).status, 401);
    const wrong = await t.call('/v1/chat/completions', 'staff', ask('anthropic/claude-sonnet-5.5'));
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).error.code, 'model_not_allowed');
    const browser = await t.call('/v1/models', 'staff', undefined, {
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(browser.status, 403);
    assert.equal(t.upstream.seen.length, 0);
  } finally {
    await t.close();
  }
});

test('monthly caps stop a person, then a department, then the organization, with a quota error Desktop understands', async () => {
  const t = await setup();
  try {
    const record = (userId: string, email: string, department: string, costUsd: number) =>
      t.ledger.record({
        at: new Date(NOW).toISOString(),
        userId,
        email,
        department,
        model: 'step-chat',
        upstream: 'x/y',
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd,
        costSource: 'provider',
        outcome: 'ok',
      });
    await record('g1002', 'other@step.example', 'unassigned', 3); // the default per-person cap is $3
    const person = await t.call('/v1/chat/completions', 'other', ask());
    assert.equal(person.status, 429);
    assert.equal((await person.json()).error.code, 'quota_exceeded');

    // staff's own cap is $5 (department override), but the IT department as a whole is capped at $10.
    await record('g9999', 'it-someone@step.example', 'it', 10);
    const department = await t.call('/v1/chat/completions', 'staff', ask());
    assert.equal(department.status, 429);
    assert.match((await department.json()).error.message, /งานไอที/);

    await record('g9998', 'big@step.example', 'unassigned', 90);
    const org = await t.call('/v1/chat/completions', 'admin', ask());
    assert.equal(org.status, 429);
    assert.match((await org.json()).error.message, /องค์กร/);
    assert.equal(t.upstream.seen.length, 0);
  } finally {
    await t.close();
  }
});

test('OpenRouter running out of credit reaches Desktop as a quota error, not a sign-in problem', async () => {
  const t = await setup((seen, res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 402, message: 'Insufficient credits' } }));
  });
  try {
    const response = await t.call('/v1/chat/completions', 'staff', ask());
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, 'credit_balance_exhausted');
  } finally {
    await t.close();
  }
});

test('a too-long prompt comes back as context_length_exceeded', async () => {
  const t = await setup((seen, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { code: 400, message: "This endpoint's maximum context length is 1000000 tokens" },
      }),
    );
  });
  try {
    const response = await t.call('/v1/chat/completions', 'staff', ask());
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'context_length_exceeded');
  } finally {
    await t.close();
  }
});

test('a stream cut short is still charged with the figure OpenRouter reports for the generation', async () => {
  const t = await setup((seen, res) => {
    if (seen.path.startsWith('/generation')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({ data: { total_cost: 0.0042, tokens_prompt: 900, tokens_completion: 12 } }),
      );
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'gen-cut', choices: [{ delta: { content: 'ครึ่ง' } }] })}\n\n`);
    // the connection drops without usage or [DONE]
    setTimeout(() => res.destroy(), 20);
  });
  try {
    const response = await t.call('/v1/chat/completions', 'staff', ask());
    await response.text().catch(() => '');
    const totals = await until(
      () => t.ledger.totals(monthOf(NOW)),
      (v) => v.org.requests === 1,
    );
    assert.equal(totals.org.usd, 0.0042);
    assert.ok(t.upstream.seen.some((s) => s.path === '/generation?id=gen-cut'));
  } finally {
    await t.close();
  }
});

test('people see their own month; only administrators see the department and per-person report', async () => {
  const t = await setup();
  try {
    await (await t.call('/v1/chat/completions', 'staff', ask())).text();
    await until(
      () => t.ledger.totals(monthOf(NOW)),
      (v) => v.org.requests === 1,
    );
    const mine = await (await t.call('/v1/usage', 'staff')).json();
    assert.deepEqual(mine, {
      month: '2026-11',
      spentUsd: 0.0123,
      capUsd: 5,
      requests: 1,
      thbPerUsd: 33,
      spentThb: 0,
    });
    assert.equal((await t.call('/v1/admin/usage', 'staff')).status, 403);
    const report = await (await t.call('/v1/admin/usage?month=2026-11', 'admin')).json();
    assert.equal(report.org.capUsd, 100);
    assert.deepEqual(
      report.departments.map((d: any) => [d.name, d.spentUsd, d.capUsd]),
      [['งานไอที', 0.0123, 10]],
    );
    assert.deepEqual(report.users[0], {
      email: 'staff@step.example',
      department: 'งานไอที',
      spentUsd: 0.0123,
      spentThb: 0,
      capUsd: 5,
      requests: 1,
    });
  } finally {
    await t.close();
  }
});

test('usage survives a restart: totals are rebuilt from the month file', async () => {
  const t = await setup();
  try {
    await (await t.call('/v1/chat/completions', 'staff', ask())).text();
    await until(
      () => t.ledger.totals(monthOf(NOW)),
      (v) => v.org.requests === 1,
    );
    const fresh = await new UsageLedger(t.dir).totals(monthOf(NOW));
    assert.equal(fresh.users.get('g1001')?.usd, 0.0123);
    assert.equal(fresh.departments.get('it')?.requests, 1);
  } finally {
    await t.close();
  }
});

test('Cloud Workspace runtimes use a signed token in their owner name, revoked when the owner is uninvited', async () => {
  const t = await setup(streamReply(), { internalSecret: 'x'.repeat(40) });
  try {
    const token = t.internal!.sign({ userId: 'g1002', email: 'other@step.example' });
    assert.equal((await t.call('/v1/models', token)).status, 200);
    const forged = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    assert.equal((await t.call('/v1/models', forged)).status, 401);
    const response = await t.call('/v1/chat/completions', token, ask());
    await response.text();
    await until(
      () => t.ledger.totals(monthOf(NOW)),
      (v) => v.users.get('g1002')?.requests === 1,
    );
    t.invited.delete('other@step.example');
    assert.equal((await t.call('/v1/models', token)).status, 401);
    const expired = internalTokens('x'.repeat(40), () => NOW - 8 * 86_400_000).sign({
      userId: 'g1001',
      email: 'staff@step.example',
    });
    assert.equal((await t.call('/v1/models', expired)).status, 401);
  } finally {
    await t.close();
  }
});

test('a broken settings file fails closed: no request goes to OpenRouter', async () => {
  const t = await setup();
  try {
    await writeFile(t.settingsPath, JSON.stringify({ ...SETTINGS, budget: { orgMonthlyUsd: -1 } }));
    const response = await t.call('/v1/chat/completions', 'staff', ask());
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'ai_config_invalid');
    assert.equal(t.upstream.seen.length, 0);
  } finally {
    await t.close();
  }
});

test('settings reject a person in two departments and duplicate model names', () => {
  const twice = {
    ...SETTINGS,
    departments: [
      { id: 'a', name: 'A', monthlyUsd: 1, members: ['x@step.example'] },
      { id: 'b', name: 'B', monthlyUsd: 1, members: ['X@step.example'] },
    ],
  };
  assert.equal(AiGatewayConfig.safeParse(twice).success, false);
  assert.equal(
    AiGatewayConfig.safeParse({ ...SETTINGS, models: [SETTINGS.models[0], SETTINGS.models[0]] }).success,
    false,
  );
});

const ROUTED = AiGatewayConfig.parse({
  models: [
    {
      id: 'step-chat',
      label: 'งานทั่วไป',
      upstream: 'deepseek/deepseek-v4.1-flash',
      price: { input: 0.051, output: 0.203 },
      default: true,
      providers: ['deepinfra', 'novita'],
      quantizations: ['fp8'],
      fallback: 'step-backup',
    },
    {
      id: 'step-vision',
      label: 'อ่านภาพและใบเสร็จ',
      upstream: 'google/gemini-3.8-flash',
      price: { input: 0.825, output: 4.125 },
    },
    {
      id: 'step-backup',
      label: 'สำรอง',
      upstream: 'anthropic/claude-haiku-5.5',
      price: { input: 0.1, output: 0.5 },
    },
    {
      id: 'step-long',
      label: 'เอกสารทางการ',
      upstream: 'anthropic/claude-sonnet-5.5',
      price: { input: 2, output: 10 },
    },
  ],
  providers: ['google-vertex', 'amazon-bedrock'],
  routes: { images: 'step-vision' },
  budget: { orgMonthlyUsd: 100, userMonthlyUsd: 3 },
});

const picture = (model = 'step-chat') =>
  ask(model, {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'อ่านใบเสร็จนี้' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        ],
      },
    ],
  });

test('task routing: text goes to the default model on its own FP8 providers, a picture to the image model', async () => {
  const t = await setup(streamReply(), { settings: ROUTED });
  try {
    for (const body of [ask(), picture(), picture('step-long')])
      assert.equal(
        (await (await t.call('/v1/chat/completions', 'staff', body)).text()).includes('[DONE]'),
        true,
      );
    const [text, image, chosen] = t.upstream.seen.map((s) => s.body);
    assert.equal(text.model, 'deepseek/deepseek-v4.1-flash');
    assert.deepEqual(text.provider, {
      zdr: true,
      data_collection: 'deny',
      only: ['deepinfra', 'novita'],
      quantizations: ['fp8'],
    });
    assert.equal(image.model, 'google/gemini-3.8-flash');
    assert.deepEqual(image.provider.only, ['google-vertex', 'amazon-bedrock']);
    assert.equal(image.provider.quantizations, undefined);
    assert.equal(chosen.model, 'anthropic/claude-sonnet-5.5', 'a model picked on purpose is kept');
    const totals = await until(
      () => t.ledger.totals(monthOf(NOW)),
      (v) => v.org.requests === 3,
    );
    assert.equal(totals.org.requests, 3);
    const lines = (await readFile(join(t.dir, 'ai-usage', `${monthOf(NOW)}.jsonl`), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).model);
    assert.deepEqual(lines.sort(), ['step-chat', 'step-long', 'step-vision']);
  } finally {
    await t.close();
  }
});

test('when the default model has no provider up, the stand-in answers once; a credit error is never retried', async () => {
  let credit = false;
  const t = await setup(
    (seen, res) => {
      if (credit) {
        res.writeHead(402, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 402, message: 'Insufficient credits' } }));
      }
      if (seen.body?.model === 'deepseek/deepseek-v4.1-flash') {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 503, message: 'No instances available' } }));
      }
      streamReply()(seen, res);
    },
    { settings: ROUTED },
  );
  try {
    const response = await t.call('/v1/chat/completions', 'staff', ask());
    assert.equal(response.status, 200);
    assert.match(await response.text(), /สวัส/);
    assert.deepEqual(
      t.upstream.seen.map((s) => s.body.model),
      ['deepseek/deepseek-v4.1-flash', 'anthropic/claude-haiku-5.5'],
    );
    assert.deepEqual(t.upstream.seen[1].body.provider.only, ['google-vertex', 'amazon-bedrock']);

    credit = true;
    const refused = await t.call('/v1/chat/completions', 'staff', ask());
    assert.equal(refused.status, 429);
    assert.equal((await refused.json()).error.code, 'credit_balance_exhausted');
    assert.equal(t.upstream.seen.length, 3, 'no second call after a credit error');
  } finally {
    await t.close();
  }
});

test('settings reject a route or fallback that names no model', () => {
  const base = JSON.parse(JSON.stringify(ROUTED));
  assert.throws(() => AiGatewayConfig.parse({ ...base, routes: { images: 'step-missing' } }));
  base.models[0].fallback = 'step-chat';
  assert.throws(() => AiGatewayConfig.parse(base));
});
