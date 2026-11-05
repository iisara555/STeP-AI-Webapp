import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedRuntimeArgs, processDriver, runtimeEnv } from '../src/workspace/process-driver.ts';
import { workspacePaths } from '../src/workspace/storage.ts';

const limit = 1024 * 1024;

test('tmpfs policy rejects invalid sizes and unsandboxed use before launch', () => {
  for (const tmpfsBytes of [0, -1, 1, 65537, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, '1048576', null]) {
    assert.throws(
      () => processDriver({ isolated: true, tmpfsBytes: tmpfsBytes as number }),
      /INVALID_TMPFS_LIMIT/,
    );
  }
  assert.throws(() => processDriver({ tmpfsBytes: limit }), /TMPFS_REQUIRES_ISOLATION/);
});

test('tmpfs mount arguments bind the limit to /tmp and drop all capabilities', () => {
  const spec = workspacePaths('/tmp/synthetic', 'synthetic', 'ws_' + 'a'.repeat(32));
  assert.equal(isolatedRuntimeArgs(spec).includes('--size'), false);
  for (const bytes of [0, 65537, NaN])
    assert.throws(() => isolatedRuntimeArgs(spec, bytes), /INVALID_TMPFS_LIMIT/);
  const args = isolatedRuntimeArgs(spec, limit);
  assert.deepEqual(args.slice(args.indexOf('--size'), args.indexOf('--size') + 4), [
    '--size',
    String(limit),
    '--tmpfs',
    '/tmp',
  ]);
  assert.deepEqual(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2), [
    '--cap-drop',
    'ALL',
  ]);
});

test('bounded mode refuses an unavailable workspace mount without an unsandboxed fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'step-tmpfs-failure-'));
  const spec = workspacePaths(root, 'synthetic', 'ws_' + 'a'.repeat(32));
  await mkdir(spec.filesDir, { recursive: true });
  try {
    await assert.rejects(
      () =>
        processDriver({ isolated: true, tmpfsBytes: limit }).start({ ...spec, dir: join(root, 'absent') }),
      { code: 'RUNTIME_START_FAILED' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('opt-in private tmpfs enforces bytes, recovers after deletion and starts the real runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'step-tmpfs-'));
  const spec = workspacePaths(root, 'synthetic', 'ws_' + 'a'.repeat(32));
  await mkdir(spec.filesDir, { recursive: true });
  try {
    const args = isolatedRuntimeArgs(spec, limit);
    const at = args.indexOf('--size');
    assert.ok(at >= 0);
    assert.deepEqual(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2), [
      '--cap-drop',
      'ALL',
    ]);
    assert.deepEqual(args.slice(at, at + 4), ['--size', String(limit), '--tmpfs', '/tmp']);
    // Bound the attempted allocation even if enforcement regresses; never stress host RAM.
    const script = `const fs=require('node:fs');const p='/tmp/fill';const fd=fs.openSync(p,'w');let bytes=0,code;try{for(let i=0;i<32;i++){bytes+=fs.writeSync(fd,Buffer.alloc(65536,1))}}catch(e){code=e.code}finally{fs.closeSync(fd)}fs.unlinkSync(p);fs.writeFileSync('/tmp/recovered','ok');console.log(JSON.stringify({code,bytes,recovered:fs.readFileSync('/tmp/recovered','utf8')}));`;
    const result = spawnSync('/usr/bin/bwrap', [...args, '-e', script], {
      cwd: spec.filesDir,
      env: runtimeEnv(spec),
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.code, 'ENOSPC');
    assert.ok(outcome.bytes <= limit);
    assert.equal(outcome.recovered, 'ok');
    const runtime = await processDriver({ isolated: true, tmpfsBytes: limit }).start(spec);
    try {
      assert.equal((await runtime.health()).ok, true);
    } finally {
      await runtime.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
