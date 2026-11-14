import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { QuotaStore } from '../src/gateway/quota-store.ts';

test('quota reservations survive reopening and concurrent connections cannot exceed the limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-quota-'));
  try {
    const path = join(dir, 'quota.sqlite');
    const a = new QuotaStore(path);
    const b = new QuotaStore(path);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve().then(() => (i % 2 ? a : b).reserve('g123', '2026-11-04', 3)),
      ),
    );
    assert.equal(results.filter(Boolean).length, 3);
    a.close();
    b.close();
    const reopened = new QuotaStore(path);
    assert.equal(reopened.reserve('g123', '2026-11-04', 3), false);
    assert.equal(reopened.reserve('g123', '2026-11-05', 3), true);
    assert.equal(reopened.reserve('g456', '2026-11-04', 3), true);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a different process can release a reservation for later admission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-quota-release-process-'));
  const path = join(dir, 'quota.sqlite');
  const store = new QuotaStore(path);
  try {
    assert.equal(store.reserve('g123', '2026-11-04', 1), true);
    const moduleUrl = pathToFileURL(join(process.cwd(), 'server/src/gateway/quota-store.ts')).href;
    const script = `import { QuotaStore } from ${JSON.stringify(moduleUrl)}; const s = new QuotaStore(process.argv[1]); s.release('g123', '2026-11-04'); s.close();`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, path], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      errors += chunk;
    });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, errors);
    assert.equal(store.reserve('g123', '2026-11-04', 1), true);
    assert.equal(store.reserve('g123', '2026-11-04', 1), false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('independent processes contend for the same durable admission counter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-quota-process-'));
  try {
    const path = join(dir, 'quota.sqlite');
    // Initialize before workers start; they synchronize their actual reservations below.
    new QuotaStore(path).close();
    const moduleUrl = pathToFileURL(join(process.cwd(), 'server/src/gateway/quota-store.ts')).href;
    const script = String.raw`
      import { QuotaStore } from ${JSON.stringify(moduleUrl)};
      const store = new QuotaStore(process.argv[1]);
      process.stdout.write('ready\n');
      process.stdin.once('data', () => {
        process.stdout.write(store.reserve('g123', '2026-11-04', 3) ? 'yes\n' : 'no\n');
        store.close();
      });
    `;
    const workers = Array.from({ length: 10 }, () => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, path], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8').on('data', (data) => {
        out += data;
      });
      child.stderr.setEncoding('utf8').on('data', (data) => {
        err += data;
      });
      return { child, output: () => out, errors: () => err };
    });
    await Promise.all(
      workers.map(async ({ child, output, errors }) => {
        while (!output().includes('ready\n')) {
          if (child.exitCode !== null) throw new Error(`worker exited before ready: ${errors()}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }),
    );
    const exits = workers.map(({ child }) => once(child, 'exit'));
    for (const { child } of workers) child.stdin.end('go');
    const codes = await Promise.all(exits);
    for (const [i, worker] of workers.entries()) assert.equal(codes[i][0], 0, worker.errors());
    assert.equal(workers.filter((worker) => worker.output().includes('yes\n')).length, 3);
    assert.equal(workers.filter((worker) => worker.output().includes('no\n')).length, 7);
    const reopened = new QuotaStore(path);
    assert.equal(reopened.reserve('g123', '2026-11-04', 3), false);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
