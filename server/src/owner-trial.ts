// Owner-only, loopback-only synthetic trial. No real provider can be configured here.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RuntimeManager } from './workspace/manager.ts';
import { processDriver } from './workspace/process-driver.ts';

const page = fileURLToPath(new URL('./owner-trial.html', import.meta.url));
const token = randomBytes(32).toString('hex');
const provider = createServer(async (req, res) => {
  // Consume the engine request locally; never forward its contents.
  for await (const _chunk of req) {
    /* discard */
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'คำตอบจำลองจาก Desktop engine' } }] })}\n\n`,
  );
  res.end('data: [DONE]\n\n');
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address();
if (!address || typeof address === 'string') throw new Error('Provider failed to start');
const manager = new RuntimeManager({
  dataRoot: process.env.STEP_TRIAL_DATA || '.data/owner-trial',
  driver: processDriver(),
  maxRunning: 1,
  grant: () => ({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic', token: 'synthetic' }),
});
let workspace = (await manager.list('owner'))[0] ?? (await manager.create('owner', { name: 'ทดลอง' }));
let busy = false;
function send(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function authorized(req: IncomingMessage) {
  const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const a = Buffer.from(supplied),
    b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
const server = createServer(async (req, res) => {
  const host = req.headers.host;
  const expectedHost = `127.0.0.1:${port}`;
  if (host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) {
    return send(res, 403, { error: 'ไม่อนุญาตคำขอนี้' });
  }
  res.setHeader('x-content-type-options', 'nosniff');
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    return res.end(await readFile(page));
  }
  if (req.method !== 'POST' || req.url !== '/api/ask') return send(res, 404, { error: 'ไม่พบหน้า' });
  if (!authorized(req)) return send(res, 401, { error: 'ไม่มีสิทธิ์ใช้งาน กรุณาเปิดลิงก์ทดลองใหม่' });
  if (busy) return send(res, 429, { error: 'กำลังประมวลผลคำขอก่อนหน้า' });
  busy = true;
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 24000) return send(res, 413, { error: 'ข้อความยาวเกินไป' });
    }
    const input = JSON.parse(body);
    if (
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      input.text.length > 20000 ||
      (input.sessionId !== undefined && typeof input.sessionId !== 'string')
    )
      return send(res, 400, { error: 'กรุณาตรวจสอบข้อความ' });
    const result = await manager.ask('owner', workspace.id, {
      text: input.text,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
    if (result.status !== 'review' || !result.answer)
      return send(res, 503, { error: 'เครื่องมือยังตอบไม่ได้ กรุณาลองใหม่' });
    return send(res, 200, { answer: result.answer, sessionId: result.sessionId });
  } catch {
    return send(res, 503, { error: 'เกิดข้อผิดพลาดในการประมวลผล กรุณาลองใหม่' });
  } finally {
    busy = false;
  }
});
const port = Number(process.env.STEP_TRIAL_PORT || 8766);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
server.listen(port, '127.0.0.1', () => console.log(`เปิด http://127.0.0.1:${port}/#${token}`));
async function shutdown() {
  server.close();
  await manager.shutdown();
  provider.close();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
