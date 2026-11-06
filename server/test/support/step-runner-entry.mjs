// Synthetic stand-ins for a runtime, used only by step-runner-driver.test.ts. The test copies this file into its
// disposable app root under several names; the name picks the behaviour. No app code, no engine, no real data.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { basename } from 'node:path';

const mode = basename(import.meta.filename, '.mjs');
const socketPath = process.env.STEP_RUNTIME_SOCKET;
let launchNonce = '';
for await (const chunk of process.stdin) launchNonce += chunk;
launchNonce = launchNonce.trim();
const hold = () => setInterval(() => {}, 60_000);

if (mode === 'fake-sleeper') {
  // Never connects: lets the test try to reach the socket first, as an unexpected peer.
  hold();
} else {
  const socket = net.createConnection(socketPath);
  const write = (message) => socket.write(JSON.stringify(message) + '\n');
  socket.on('error', () => {});
  socket.on('connect', () => {
    if (mode === 'fake-wrong-nonce') return write({ type: 'ready', launchNonce: '0'.repeat(64) });
    if (mode === 'fake-flood') return socket.write('x'.repeat(2 * 1024 * 1024));
    if (mode === 'fake-stubborn') {
      // A detached descendant in its own session that ignores SIGTERM, and a runtime that ignores shutdown.
      spawn('/bin/sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      process.on('SIGTERM', () => {});
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
          const request = JSON.parse(buffer.slice(0, at));
          buffer = buffer.slice(at + 1);
          write({
            type: 'result',
            nonce: request.nonce,
            ok: true,
            result: { ok: true, workspaceId: 'fake' },
          });
        }
      });
      socket.on('end', () => {});
      write({ type: 'ready', launchNonce });
      hold();
    }
  });
}
