import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { IdentityService } from './identity.ts';
import { RuntimeManager } from './workspace/manager.ts';
import { processDriver } from './workspace/process-driver.ts';
import type { RuntimeDriver } from './workspace/contract.ts';

const page = fileURLToPath(new URL('./identity-gateway.html', import.meta.url));
export async function createIdentityGateway(options: {
  identities: IdentityService;
  dataRoot: string;
  clientId: string;
  origin: string;
  driver?: RuntimeDriver;
  idleMs?: number;
  sweepMs?: number;
}) {
  const provider = createServer(async (req, res) => {
    for await (const _ of req) {
      /* local synthetic endpoint discards all content */
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'คำตอบจำลองจาก Desktop engine' } }] })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('PROVIDER_START_FAILED');
  const manager = new RuntimeManager({
    dataRoot: options.dataRoot,
    driver: options.driver ?? processDriver(),
    idleMs: options.idleMs,
    grant: () => ({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic', token: 'synthetic' }),
  });
  const sweepMs = options.sweepMs ?? 60_000;
  if (!Number.isFinite(sweepMs) || sweepMs <= 0) throw new Error('INVALID_SWEEP_INTERVAL');
  const sweeper = setInterval(() => void manager.sweepIdle().catch(() => {}), sweepMs);
  sweeper.unref();
  const workspaces = new Map<string, Promise<string>>();
  function workspace(userId: string) {
    let pending = workspaces.get(userId);
    if (!pending) {
      pending = (async () =>
        (await manager.list(userId))[0]?.id ?? (await manager.create(userId, { name: 'Workspace' })).id)();
      workspaces.set(userId, pending);
      pending.catch(() => workspaces.delete(userId));
    }
    return pending;
  }
  function send(res: ServerResponse, status: number, value: object) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  }
  async function body(req: IncomingMessage) {
    let result = '';
    for await (const part of req) {
      result += part;
      if (result.length > 24000) throw new Error('TOO_LARGE');
    }
    return JSON.parse(result);
  }
  const server = createServer(async (req, res) => {
    try {
      const origin = new URL(options.origin);
      if (req.headers.host !== origin.host || (req.headers.origin && req.headers.origin !== origin.origin))
        return send(res, 403, { error: 'ไม่อนุญาตคำขอนี้' });
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy':
            "default-src 'none'; script-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/client; style-src 'unsafe-inline' https://accounts.google.com/gsi/style; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/; base-uri 'none'; frame-ancestors 'none'",
        });
        return res.end(await readFile(page));
      }
      if (req.method === 'GET' && req.url === '/api/config')
        return send(res, 200, { clientId: options.clientId });
      if (
        req.method !== 'POST' ||
        req.headers.origin !== origin.origin ||
        !req.headers['content-type']?.startsWith('application/json')
      )
        return send(res, 403, { error: 'ไม่อนุญาตคำขอนี้' });
      if (req.url === '/api/login') {
        const input = await body(req);
        if (typeof input.credential !== 'string') return send(res, 400, { error: 'ข้อมูลไม่ถูกต้อง' });
        try {
          return send(res, 200, { token: await options.identities.login(input.credential) });
        } catch {
          return send(res, 401, { error: 'ไม่สามารถเข้าสู่ระบบได้ โปรดตรวจสอบสิทธิ์' });
        }
      }
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const session = await options.identities.authorize(token);
      if (!session) return send(res, 401, { error: 'ไม่มีสิทธิ์ใช้งาน หรือสิทธิ์หมดอายุ' });
      if (req.url === '/api/logout') {
        options.identities.logout(token);
        return send(res, 200, { ok: true });
      }
      if (req.url !== '/api/ask') return send(res, 404, { error: 'ไม่พบหน้า' });
      const input = await body(req);
      if (
        typeof input.text !== 'string' ||
        !input.text.trim() ||
        input.text.length > 20000 ||
        (input.sessionId !== undefined && typeof input.sessionId !== 'string')
      )
        return send(res, 400, { error: 'กรุณาตรวจสอบข้อความ' });
      const id = await workspace(session.userId);
      // Recheck after potentially slow workspace creation and immediately before starting work.
      if (!(await options.identities.authorize(token)))
        return send(res, 401, { error: 'สิทธิ์ใช้งานหมดอายุ' });
      const result = await manager.ask(session.userId, id, {
        text: input.text,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      });
      if (!(await options.identities.authorize(token)))
        return send(res, 401, { error: 'สิทธิ์ใช้งานหมดอายุ' });
      if (result.status !== 'review' || !result.answer)
        return send(res, 503, { error: 'เครื่องมือยังตอบไม่ได้ กรุณาลองใหม่' });
      return send(res, 200, { answer: result.answer, sessionId: result.sessionId });
    } catch {
      return send(res, 503, { error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' });
    }
  });
  return {
    server,
    close: async () => {
      clearInterval(sweeper);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await manager.shutdown();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    },
  };
}
