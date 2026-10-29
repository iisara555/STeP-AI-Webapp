// ADR 0001 phase 3 pass criterion through the real pieces: the Gateway's HTTP API, a Workspace runtime process
// running the pinned Desktop engine, and a loopback AI endpoint that answers only when released. Nothing leaves the
// machine and no real account is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Authenticator } from '../src/gateway/auth.ts';
import { createGateway } from '../src/gateway/http.ts';
import { RunService } from '../src/gateway/runs.ts';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { processDriver } from '../src/workspace/process-driver.ts';

async function heldProvider() {
  let requests = 0;
  let release: () => void = () => {};
  let held = new Promise<void>((done) => (release = done));
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    requests++;
    await held;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ติดต่อฝ่ายบุคคล' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ผ่านระบบ HR' } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests: () => requests,
    release: () => release(),
    hold() {
      held = new Promise<void>((done) => (release = done));
    },
    close: () => {
      release();
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    },
  };
}

type Event = { id: number; type: string; data: any };

async function readUntil(response: Response, enough: (events: Event[]) => boolean) {
  const events: Event[] = [];
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  while (!enough(events)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const field = (name: string) => new RegExp(`^${name}: (.*)$`, 'm').exec(block)?.[1];
      if (field('event'))
        events.push({ id: Number(field('id')), type: field('event')!, data: JSON.parse(field('data')!) });
    }
  }
  await reader.cancel();
  return events;
}

async function until<T>(check: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((done) => setTimeout(done, 50));
  }
}

test('closing the browser leaves the run working; coming back resumes it, and a later run can be cancelled', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'step-gateway-runtime-'));
  const provider = await heldProvider();
  const manager = new RuntimeManager({
    dataRoot,
    driver: processDriver(),
    grant: () => ({ baseUrl: provider.baseUrl, model: 'synthetic', token: 'synthetic-token' }),
  });
  const authenticate: Authenticator = async (header) =>
    header === 'Bearer alice' ? { userId: 'alice', email: 'alice@step.example', admin: false } : null;
  const audit = () => {};
  const server = createGateway({ manager, runs: new RunService(manager, audit), authenticate, audit });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit = {}) =>
    fetch(url + path, {
      ...init,
      headers: {
        authorization: 'Bearer alice',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string>),
      },
    });
  try {
    const workspace = await (
      await call('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'HR' }) })
    ).json();
    const base = `/api/workspaces/${workspace.id}`;
    const run = await (
      await call(`${base}/runs`, {
        method: 'POST',
        body: JSON.stringify({ text: 'ติดต่อฝ่ายบุคคลช่องทางไหน' }),
      })
    ).json();
    assert.equal(run.status, 'running');

    // The browser sees the run start, then the tab is closed while the AI is still thinking.
    const first = await readUntil(await call(`${base}/events`), (events) =>
      events.some((e) => e.type === 'run'),
    );
    assert.equal(first[0].data.status, 'running');
    await until(async () => (provider.requests() > 0 ? true : undefined));

    provider.release();
    const finished = await until(async () => {
      const current = await (await call(`${base}/runs/${run.id}`)).json();
      return current.status === 'running' ? undefined : current;
    });
    assert.equal(finished.status, 'done');

    // A returning client gets the streamed answer it missed and the result, from where it left off.
    const replay = await readUntil(
      await call(`${base}/events`, { headers: { 'last-event-id': String(first.at(-1)!.id) } }),
      (events) => events.some((e) => e.type === 'run'),
    );
    const streamed = replay
      .filter((e) => e.type === 'delta')
      .map((e) => e.data.text)
      .join('');
    assert.match(streamed, /ติดต่อฝ่ายบุคคล/);
    const result = replay.find((e) => e.type === 'run')!.data;
    assert.equal(result.status, 'done');
    assert.match(result.answer, /ผ่านระบบ HR/);
    assert.ok(
      result.sources.some((s: string) => s.includes('HR Service Channels')),
      'grounded on the HR document',
    );

    const messages = await (await call(`${base}/conversations/${run.sessionId}/messages`)).json();
    assert.deepEqual(
      messages.map((m: { role: string }) => m.role),
      ['user', 'assistant'],
    );

    // A second question in the same conversation, cancelled while the AI is working.
    provider.hold();
    const before = provider.requests();
    const second = await (
      await call(`${base}/runs`, {
        method: 'POST',
        body: JSON.stringify({ text: 'ลาพักผ่อนได้กี่วัน', sessionId: run.sessionId }),
      })
    ).json();
    await until(async () => (provider.requests() > before ? true : undefined));
    assert.equal((await call(`${base}/runs/${second.id}/cancel`, { method: 'POST' })).status, 200);
    const cancelled = await until(async () => {
      const current = await (await call(`${base}/runs/${second.id}`)).json();
      return current.status === 'running' ? undefined : current;
    });
    assert.deepEqual([cancelled.status, cancelled.code], ['cancelled', 'CANCELLED']);
    const conversations = await (await call(`${base}/conversations`)).json();
    assert.equal(conversations.find((c: { id: string }) => c.id === run.sessionId).status, 'cancelled');
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await manager.shutdown();
    await provider.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
