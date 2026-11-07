// Gateway-side client of the installed native quota broker (native/quota-broker, transport.c).
// One request per connection: write the fixed frame, half-close, read the complete reply until EOF.
// Bounded (reply size, deadline) and exact: anything but a byte-exact known reply is a failure.
// The broker authenticates this process by SO_PEERCRED (gateway uid); nothing here is authority.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import net from 'node:net';
import { z } from 'zod';

export const CanonicalUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** Longest broker reply (OK/3) is 179 bytes; anything longer is malformed. */
export const MAX_BROKER_REPLY_BYTES = 256;
export const DEFAULT_BROKER_TIMEOUT_MS = 2000;

const u32 = '([1-9][0-9]{0,9})';
const u64 = '(0|[1-9][0-9]{0,19})';
const pos64 = '([1-9][0-9]{0,19})';
const uuid = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const WORKSPACE_REPLY = new RegExp(`^OK/3 ${u32} ${u64} ${pos64} ${pos64} ${pos64} ${pos64} ${uuid}\\n$`);
const USAGE_REPLY = new RegExp(`^USAGE/1 ${u32} ${u64} ${pos64} ${u64} ${pos64}\\n$`);
const MAX_U64 = 18446744073709551615n;

export class BrokerError extends Error {}

/** What the broker verified for one workspace inside the user's pool (reply OK/3). */
export type BrokerWorkspaceReceipt = {
  userUuid: string;
  workspaceUuid: string;
  projectId: number;
  /** Canonical decimal strings, never lossy JS numbers. */
  device: string;
  userInode: string;
  inode: string;
  bytesHard: number;
  inodesHard: number;
  mountUuid: string;
};
export type BrokerUsage = {
  projectId: number;
  bytesUsed: number;
  bytesHard: number;
  inodesUsed: number;
  inodesHard: number;
};
export type BrokerClient = {
  ensureWorkspace(userUuid: string, workspaceUuid: string): Promise<BrokerWorkspaceReceipt>;
  usage(userUuid: string): Promise<BrokerUsage>;
};

function u64String(text: string) {
  if (BigInt(text) > MAX_U64) throw new BrokerError('NATIVE_QUOTA_MALFORMED_REPLY');
  return text;
}
function safeNumber(text: string) {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new BrokerError('NATIVE_QUOTA_MALFORMED_REPLY');
  return value;
}

/** One bounded exchange. Rejects on denial, timeout, oversize, early close or any malformed byte. */
export function brokerExchange(socketPath: string, frame: string, timeoutMs = DEFAULT_BROKER_TIMEOUT_MS) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const socket = net.createConnection({ path: socketPath });
    const finish = (error: Error | undefined, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new BrokerError('NATIVE_QUOTA_BROKER_TIMEOUT')), timeoutMs);
    socket.on('connect', () => {
      // Exactly the frame, then write EOF: the broker accepts no pipelining or trailing bytes.
      socket.end(frame, 'latin1');
    });
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BROKER_REPLY_BYTES) return finish(new BrokerError('NATIVE_QUOTA_MALFORMED_REPLY'));
      chunks.push(chunk);
    });
    socket.on('end', () => {
      const bytes = Buffer.concat(chunks);
      // ASCII only; a reply without its final newline is a partial (unknown) exchange.
      if (bytes.some((b) => b > 0x7e || (b < 0x20 && b !== 0x0a)))
        return finish(new BrokerError('NATIVE_QUOTA_MALFORMED_REPLY'));
      const text = bytes.toString('latin1');
      if (text === 'DENIED/1\n') return finish(new BrokerError('NATIVE_QUOTA_DENIED'));
      finish(undefined, text);
    });
    socket.on('error', () => finish(new BrokerError('NATIVE_QUOTA_BROKER_UNAVAILABLE')));
    socket.on('close', () => finish(new BrokerError('NATIVE_QUOTA_BROKER_UNAVAILABLE')));
  });
}

export function brokerClient(options: { socketPath: string; timeoutMs?: number }): BrokerClient {
  const { socketPath } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_BROKER_TIMEOUT_MS;
  return {
    async ensureWorkspace(user, workspace) {
      const userUuid = CanonicalUuid.parse(user);
      const workspaceUuid = CanonicalUuid.parse(workspace);
      const text = await brokerExchange(socketPath, `WORKSPACE/1 ${userUuid} ${workspaceUuid}\n`, timeoutMs);
      const m = WORKSPACE_REPLY.exec(text);
      if (!m) throw new BrokerError('NATIVE_QUOTA_MALFORMED_REPLY');
      return {
        // Bound to this exact request: one request per connection, so no correlation id is needed.
        userUuid,
        workspaceUuid,
        projectId: safeNumber(m[1]!),
        device: u64String(m[2]!),
        userInode: u64String(m[3]!),
        inode: u64String(m[4]!),
        bytesHard: safeNumber(m[5]!),
        inodesHard: safeNumber(m[6]!),
        mountUuid: m[7]!,
      };
    },
    async usage(user) {
      const userUuid = CanonicalUuid.parse(user);
      const text = await brokerExchange(socketPath, `USAGE/1 ${userUuid}\n`, timeoutMs);
      const m = USAGE_REPLY.exec(text);
      if (!m) throw new BrokerError('NATIVE_QUOTA_MALFORMED_REPLY');
      return {
        projectId: safeNumber(m[1]!),
        bytesUsed: safeNumber(m[2]!),
        bytesHard: safeNumber(m[3]!),
        inodesUsed: safeNumber(m[4]!),
        inodesHard: safeNumber(m[5]!),
      };
    },
  };
}

/** UI warning thresholds of the per-user pool (owner decision: warn at 80 % and 95 %). */
export const USAGE_WARNING = 0.8;
export const USAGE_CRITICAL = 0.95;
export type UsageLevel = 'ok' | 'warning' | 'critical' | 'full';
/** The worse of the byte and inode ratios decides; at/over the hard limit the pool is full. */
export function usageLevel(usage: BrokerUsage) {
  const bytes = usage.bytesUsed / usage.bytesHard;
  const inodes = usage.inodesUsed / usage.inodesHard;
  const worst = Math.max(bytes, inodes);
  const level: UsageLevel =
    worst >= 1 ? 'full' : worst >= USAGE_CRITICAL ? 'critical' : worst >= USAGE_WARNING ? 'warning' : 'ok';
  return {
    level,
    bytesPercent: Math.floor(bytes * 1000) / 10,
    inodesPercent: Math.floor(inodes * 1000) / 10,
  };
}

/** Same strict format as native/quota-broker/policy.c (the broker re-validates on its side). */
export type BrokerPolicy = {
  mountUuid: string;
  rootDevice: string;
  rootInode: string;
  bytesHard: number;
  inodesHard: number;
  firstProjectId: number;
  lastProjectId: number;
  gatewayUid: number;
  gatewayGid: number;
  workloadUid: number;
  users: string[];
};
const KEYS = [
  'version',
  'epoch',
  'mount_uuid',
  'root_device',
  'root_inode',
  'bytes_hard',
  'inodes_hard',
  'first_project',
  'last_project',
  'gateway_uid',
  'gateway_gid',
  'workload_uid',
] as const;
export function parseBrokerPolicy(text: string): BrokerPolicy {
  const invalid = (line: number): never => {
    throw new BrokerError(`NATIVE_QUOTA_POLICY_INVALID:${line}`);
  };
  if (text.length === 0 || text.length > 32768 || !text.endsWith('\n')) invalid(0);
  const values = new Map<string, string>();
  const users: string[] = [];
  const lines = text.slice(0, -1).split('\n');
  lines.forEach((line, i) => {
    if (line.length > 128) invalid(i + 1);
    if (line === '' || (line.startsWith('#') && /^[\x20-\x7e]*$/.test(line))) return;
    const m = /^([a-z_]+)=([\x21-\x7e]+)$/.exec(line);
    if (!m) return invalid(i + 1);
    const [, key, value] = m as unknown as [string, string, string];
    if (key === 'user') {
      if (!CanonicalUuid.safeParse(value).success || users.includes(value) || users.length >= 512)
        invalid(i + 1);
      users.push(value);
    } else if ((KEYS as readonly string[]).includes(key) && !values.has(key)) values.set(key, value);
    else invalid(i + 1);
  });
  const num = (key: string, min: number, max: number) => {
    const v = values.get(key);
    if (!v || !/^(0|[1-9][0-9]*)$/.test(v) || Number(v) < min || Number(v) > max) return invalid(0);
    return Number(v);
  };
  const dec64 = (key: string) => {
    const v = values.get(key);
    if (!v || !/^[1-9][0-9]{0,19}$/.test(v) || BigInt(v) > MAX_U64) return invalid(0);
    return v;
  };
  if (values.size !== KEYS.length || users.length === 0 || values.get('version') !== '1') invalid(0);
  if (!/^[0-9a-f]{32}$/.test(values.get('epoch')!) || /^0+$/.test(values.get('epoch')!)) invalid(0);
  const mountUuid = values.get('mount_uuid')!;
  if (!CanonicalUuid.safeParse(mountUuid).success || !/[1-9a-f]/.test(mountUuid)) invalid(0);
  const bytesHard = num('bytes_hard', 4096, 1099511627776);
  if (bytesHard % 4096) invalid(0);
  const policy: BrokerPolicy = {
    mountUuid,
    rootDevice: dec64('root_device'),
    rootInode: dec64('root_inode'),
    bytesHard,
    inodesHard: num('inodes_hard', 1, 10000000),
    firstProjectId: num('first_project', 100000, 199999),
    lastProjectId: num('last_project', 100000, 199999),
    gatewayUid: num('gateway_uid', 1, 2147483646),
    gatewayGid: num('gateway_gid', 1, 2147483646),
    workloadUid: num('workload_uid', 1, 2147483646),
    users,
  };
  if (
    policy.firstProjectId > policy.lastProjectId ||
    policy.lastProjectId - policy.firstProjectId + 1 < users.length
  )
    invalid(0);
  return policy;
}
/** Read the fixed root-owned policy file (production owner 0). Refuses links, foreign owners, other modes. */
export async function readBrokerPolicy(path: string, owner = 0): Promise<BrokerPolicy> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new BrokerError('NATIVE_QUOTA_POLICY_UNSAFE');
  });
  try {
    const s = await file.stat();
    const mode = s.mode & 0o7777;
    if (!s.isFile() || s.uid !== owner || s.nlink !== 1 || (mode !== 0o644 && mode !== 0o600))
      throw new BrokerError('NATIVE_QUOTA_POLICY_UNSAFE');
    if (s.size < 1 || s.size > 32768) throw new BrokerError('NATIVE_QUOTA_POLICY_INVALID:0');
    return parseBrokerPolicy(await file.readFile('latin1'));
  } finally {
    await file.close();
  }
}
