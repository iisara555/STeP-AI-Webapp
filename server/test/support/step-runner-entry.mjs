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
    if (mode === 'fake-resources') {
      // Pressure is armed only by a host test AFTER it checks the effective cgroup limits.
      setTimeout(() => process.exit(90), 20_000);
      socket.on('end', () => process.exit(0));
      let buffer = '';
      let armed = false;
      const children = [];
      socket.on('data', async (chunk) => {
        buffer += chunk;
        for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
          const request = JSON.parse(buffer.slice(0, at));
          buffer = buffer.slice(at + 1);
          const reply = (result) => write({ type: 'result', nonce: request.nonce, ok: true, result });
          if (request.method === 'ask' && request.params.text.endsWith('-pressure')) {
            if (armed) {
              reply({ error: 'ALREADY_ARMED' });
              continue;
            }
            armed = true;
          }
          if (request.method === 'ask' && request.params.text === 'bounded-memory-pressure') {
            // One worker, no recursion, <=384 MiB touched even if the kernel limit regresses.
            // The child has no loader imports; the independent timer also bounds the no-OOM case.
            const child = spawn(
              process.execPath,
              [
                '-e',
                `
              require('node:fs').writeFileSync('/proc/self/oom_score_adj', '1000');
              const held = [];
              const timer = setInterval(() => {
                if (held.length === 96) return clearInterval(timer);
                held.push(Buffer.alloc(4 * 1024 * 1024, 1));
              }, 10);
              setTimeout(() => process.exit(91), 10000);
            `,
              ],
              { stdio: 'ignore' },
            );
            child.once('error', (error) => reply({ error: error.code }));
            child.once('exit', (code, signal) => reply({ code, signal }));
          } else if (request.method === 'ask' && request.params.text === 'bounded-cpu-pressure') {
            // One direct single-threaded worker, at most 2s wall time even if quota is absent.
            // Its monotonic deadline works inside the busy loop; a separate parent timer kills hangs.
            const child = spawn(
              '/usr/bin/python3',
              [
                '-I',
                '-S',
                '-c',
                `
import time
end = time.monotonic() + 2
while time.monotonic() < end:
    pass
`,
              ],
              { stdio: 'ignore' },
            );
            const deadline = setTimeout(() => child.kill('SIGKILL'), 4_000);
            child.once('error', (error) => {
              clearTimeout(deadline);
              reply({ error: error.code });
            });
            child.once('close', (code, signal) => {
              clearTimeout(deadline);
              reply({ code, signal });
            });
          } else if (request.method === 'ask' && request.params.text === 'bounded-task-pressure') {
            // Flat, sequential, finite list: at most 48 direct sleep children, never a fork tree.
            // Every child self-exits after 15s even if the test/IPC disappears.
            let denied = null;
            for (let i = 0; i < 48; i++) {
              const child = spawn('/bin/sleep', ['15'], { stdio: 'ignore' });
              const done = new Promise((resolve) => child.once('close', resolve));
              denied = await new Promise((resolve) => {
                child.once('error', (error) => resolve(error.code));
                child.once('spawn', () => {
                  children.push({ child, done });
                  resolve(null);
                });
              });
              if (denied) break;
            }
            reply({ denied, spawned: children.length });
          } else if (request.method === 'conversations') {
            for (const { child } of children) child.kill('SIGKILL');
            await Promise.all(children.map(({ done }) => done));
            reply([]);
          } else if (request.method === 'ask' && request.params.text === 'bounded-task-recovery') {
            const child = spawn('/bin/true', [], { stdio: 'ignore' });
            child.once('error', (error) => reply({ error: error.code }));
            child.once('exit', (code, signal) => reply({ code, signal }));
          } else reply({ ok: true });
        }
      });
      write({ type: 'ready', launchNonce });
    }
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
