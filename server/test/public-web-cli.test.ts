import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The actual CLI uses a local synthetic compatible provider and never reaches a public website.
test('ask and a selected benchmark question accept the public-web trial flag', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-web-cli-'));
  const provider = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* consume the request */
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'คำตอบทดสอบ' } }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
  const { port } = provider.address() as AddressInfo;
  const root = resolve(import.meta.dirname, '../..');
  const run = (script: string, ...args: string[]) =>
    new Promise<{ code: number | null; output: string }>((done, fail) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--import', './server/src/register.mjs', script, ...args],
        {
          cwd: root,
          env: {
            ...process.env,
            STEP_AI_DATA: join(dir, 'fresh-data'),
            STEP_AI_KEY: 'synthetic',
            STEP_AI_MODEL: 'synthetic',
            STEP_AI_BASE_URL: `http://127.0.0.1:${port}/v1`,
          },
        },
      );
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      child.on('error', fail);
      child.on('close', (code) => done({ code, output }));
    });
  try {
    const ask = await run(
      'server/src/ask.ts',
      '--public-web',
      '--user',
      'owner',
      'ติดต่อฝ่ายบุคคลช่องทางไหน',
    );
    assert.equal(ask.code, 0, ask.output);
    assert.match(ask.output, /คำตอบทดสอบ/);
    const bench = await run('server/src/bench.ts', '--public-web', '--question', 'ติดต่อฝ่ายบุคคลช่องทางไหน');
    assert.equal(bench.code, 0, bench.output);
    const reportDir = join(dir, 'fresh-data', 'bench');
    const [file] = await readdir(reportDir);
    const report = JSON.parse(await readFile(join(reportDir, file), 'utf8'));
    assert.equal(report.summary.publicWeb, true);
    assert.equal(report.summary.questions, 1);
    assert.equal(report.results[0].q, 'ติดต่อฝ่ายบุคคลช่องทางไหน');
    assert.equal(report.results[0].webSearchSucceeded, false);
    assert.equal(report.results[0].webReadSucceeded, false);
  } finally {
    await new Promise<void>((done) => provider.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
});
