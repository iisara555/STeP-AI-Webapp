import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

let child: ChildProcess;
let dir: string;
let url: string;
let origin: string;
test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'step-trial-'));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    ['--import', 'tsx', '--import', './server/src/register.mjs', 'server/src/owner-trial.ts'],
    {
      env: { ...process.env, STEP_TRIAL_PORT: String(port), STEP_TRIAL_DATA: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('trial startup timeout')), 30000);
    child.stdout!.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\/#\w+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`trial exited ${code}`));
    });
  });
});
test.afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});
test('owner sends a synthetic message through the gateway and engine', async ({ page, request }) => {
  expect((await request.post(origin + '/api/ask', { data: { text: 'test' } })).status()).toBe(401);
  expect(
    (
      await request.post(origin + '/api/ask', {
        headers: { origin: 'http://evil.example' },
        data: { text: 'test' },
      })
    ).status(),
  ).toBe(403);
  await page.goto(url);
  await page.getByLabel('ข้อความทดลอง').fill('ช่วยคิดชื่องานสัมมนาให้หน่อย');
  await page.getByRole('button', { name: 'ส่งข้อความ' }).click();
  await expect(page.getByText('Engine: คำตอบจำลองจาก Desktop engine')).toBeVisible({ timeout: 30000 });
  await page.getByLabel('ข้อความทดลอง').fill('ขออีกสามชื่อ');
  await page.getByRole('button', { name: 'ส่งข้อความ' }).click();
  await expect(page.getByText('Engine: คำตอบจำลองจาก Desktop engine')).toHaveCount(2, { timeout: 30000 });
});
