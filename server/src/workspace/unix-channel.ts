// Bounded newline JSON and inherited capability authentication. No secret in argv/env/files.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { RuntimeReply, RuntimeRequest } from './process-driver.ts';

const MAX_FRAME = 1024 * 1024;
const MAX_QUEUE = 4 * MAX_FRAME;
const proof = (key: string, role: string, challenge: string) =>
  createHmac('sha256', key).update(`step-runtime-v1:${role}:${challenge}`).digest('hex');
function equal(a: unknown, b: string) {
  return typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function jsonChannel(socket: Socket, receive: (value: any) => void) {
  let pending = Buffer.alloc(0);
  socket.on('error', () => {});
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (!socket.destroyed) {
      const end = pending.indexOf(10);
      if (end < 0) {
        if (pending.length > MAX_FRAME) socket.destroy();
        return;
      }
      if (end > MAX_FRAME) return void socket.destroy();
      const frame = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return void socket.destroy();
        receive(value);
      } catch {
        socket.destroy();
      }
    }
  });
  return (value: unknown) => {
    const data = JSON.stringify(value) + '\n';
    const bytes = Buffer.byteLength(data);
    if (socket.destroyed) throw new Error('RUNTIME_CHANNEL_CLOSED');
    // Local size rejection writes nothing: the healthy peer can still receive a small error reply.
    if (bytes > MAX_FRAME) throw new Error('RUNTIME_FRAME_TOO_LARGE');
    if (socket.writableLength + bytes > MAX_QUEUE) {
      socket.destroy();
      throw new Error('RUNTIME_CHANNEL_CLOSED');
    }
    socket.write(data);
  };
}

function isReply(value: any): value is RuntimeReply {
  if (value.type === 'ready') return true;
  if (value.type === 'result')
    return (
      Number.isSafeInteger(value.nonce) &&
      value.nonce > 0 &&
      (value.ok === true ||
        (value.ok === false && typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value.code)))
    );
  return (
    value.type === 'event' &&
    value.event &&
    typeof value.event.sessionId === 'string' &&
    ['delta', 'discard', 'activity', 'status'].includes(value.event.type) &&
    (value.event.text === undefined || typeof value.event.text === 'string') &&
    (value.event.count === undefined || Number.isFinite(value.event.count))
  );
}

/** Prepare before admission; spawn itself remains synchronous inside the manager's fence. */
export async function prepareUnixRuntime(socketRoot = tmpdir()) {
  const directory = await mkdtemp(join(socketRoot, 'ipc-'));
  const path = join(directory, 'runtime.sock');
  const key = randomBytes(32).toString('hex');
  const sockets = new Set<Socket>();
  let child: ChildProcess | undefined;
  let active: Socket | undefined;
  let send: ReturnType<typeof jsonChannel> | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = () =>
    (disposal ??= (async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    })());
  const server = createServer((socket) => {
    if (active || sockets.size >= 8) return void socket.destroy();
    sockets.add(socket);
    const challenge = randomBytes(32).toString('hex');
    const timer = setTimeout(() => socket.destroy(), 2000);
    socket.once('close', () => {
      clearTimeout(timer);
      sockets.delete(socket);
      if (active === socket && child) {
        Object.defineProperty(child, 'connected', { value: false, writable: true, configurable: true });
        child.emit('disconnect');
      }
    });
    const write = jsonChannel(socket, (value) => {
      if (active === socket) {
        if (!isReply(value)) return void socket.destroy();
        child?.emit('message', value);
        return;
      }
      if (
        active ||
        !child ||
        !equal(value.proof, proof(key, 'runtime', challenge)) ||
        typeof value.challenge !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.challenge)
      )
        return void socket.destroy();
      active = socket;
      clearTimeout(timer);
      send = write;
      Object.defineProperty(child, 'connected', { value: true, writable: true, configurable: true });
      write({ proof: proof(key, 'manager', value.challenge) });
      // One authenticated peer per incarnation; reject all other already-connected contenders.
      for (const other of sockets) if (other !== socket) other.destroy();
    });
    write({ challenge });
  });
  try {
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(path, () => {
        server.off('error', fail);
        done();
      });
    });
    // Cross-account clients may connect, but permissions/UID are NOT authentication.
    // The directory is manager-owned (not writable by the runner); only an inherited key proves authority.
    await chmod(directory, 0o711);
    await chmod(path, 0o666);
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    directory,
    dispose,
    spawn(command: string, args: string[], options: SpawnOptions): ChildProcess {
      if (child || disposal) throw new Error('RUNTIME_START_ADMISSION_REPEATED');
      child = spawn(command, args, { ...options, stdio: ['pipe', 'ignore', 'inherit'] });
      Object.defineProperty(child, 'connected', { value: false, writable: true, configurable: true });
      // Existing driver lifecycle/RPC correlation stays at the approved seam.
      child.send = ((message: RuntimeRequest) => {
        if (!child!.connected || !send) throw new Error('RUNTIME_CHANNEL_CLOSED');
        send(message);
        return true;
      }) as ChildProcess['send'];
      child.disconnect = () => {
        active?.destroy();
      };
      child.stdin!.on('error', () => {});
      child.stdin!.end(JSON.stringify({ path, key }) + '\n');
      child.once('exit', () => {
        void dispose().catch(() => {});
      });
      child.once('error', () => {
        if (!child?.pid) void dispose().catch(() => {});
      });
      return child;
    },
  };
}

/** Runtime side: consume bootstrap only from standard input, which survives sudo-rs. */
export async function runtimeUnixChannel() {
  const bootstrap = await new Promise<{ path: string; key: string }>((done, fail) => {
    let data = '';
    const timer = setTimeout(() => fail(new Error('RUNTIME_BOOTSTRAP_TIMEOUT')), 5000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > 8192) {
        clearTimeout(timer);
        fail(new Error('RUNTIME_BOOTSTRAP_INVALID'));
        process.stdin.destroy();
      }
    });
    process.stdin.once('error', fail);
    process.stdin.once('end', () => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(data);
        if (typeof value.path !== 'string' || !/^[a-f0-9]{64}$/.test(value.key)) throw new Error();
        done(value);
      } catch {
        fail(new Error('RUNTIME_BOOTSTRAP_INVALID'));
      }
    });
  });
  const socket = createConnection(bootstrap.path);
  const listeners = new Set<(message: RuntimeRequest) => void>();
  let authenticated = false;
  let challenged = false;
  const challenge = randomBytes(32).toString('hex');
  let write!: ReturnType<typeof jsonChannel>;
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.once('close', () => {
      clearTimeout(timer);
      if (!authenticated) fail(new Error('RUNTIME_AUTH_FAILED'));
      else if (!process.emit('disconnect')) process.exit(0);
    });
    write = jsonChannel(socket, (value) => {
      if (!challenged) {
        if (typeof value.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(value.challenge))
          return void socket.destroy();
        challenged = true;
        write({ proof: proof(bootstrap.key, 'runtime', value.challenge), challenge });
      } else if (!authenticated) {
        if (!equal(value.proof, proof(bootstrap.key, 'manager', challenge))) return void socket.destroy();
        authenticated = true;
        clearTimeout(timer);
        done();
      } else {
        if (
          value.type !== 'call' ||
          !Number.isSafeInteger(value.nonce) ||
          value.nonce < 1 ||
          typeof value.method !== 'string'
        )
          return void socket.destroy();
        for (const listener of listeners) listener(value);
      }
    });
  });
  return {
    send: (message: RuntimeReply) => write(message),
    onMessage: (listener: (message: RuntimeRequest) => void) => listeners.add(listener),
  };
}
