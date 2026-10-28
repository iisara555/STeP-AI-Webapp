import { test, expect } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { IdentityService } from '../../server/src/identity.ts';
import { createIdentityGateway } from '../../server/src/identity-gateway.ts';

test('an invited synthetic account signs in and chats through the gateway', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'identity-web-'));
  const invitations = join(dir, 'invites.json');
  await writeFile(
    invitations,
    JSON.stringify([
      {
        id: 'synthetic-invite-12345',
        email: 'alice@example.org',
        expiresAt: '2099-01-01T00:00:00.000Z',
        revoked: false,
      },
    ]),
  );
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const identities = new IdentityService('example.org', invitations, async () => ({
    subject: 'alice',
    email: 'alice@example.org',
    domain: 'example.org',
  }));
  const gateway = await createIdentityGateway({ identities, dataRoot: dir, clientId: 'synthetic', origin });
  await new Promise<void>((resolve) => gateway.server.listen(port, '127.0.0.1', resolve));
  try {
    await page.route('https://accounts.google.com/gsi/client', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `window.google={accounts:{id:{initialize:({callback})=>{window.syntheticLogin=callback},renderButton:(el)=>{const b=document.createElement('button');b.textContent='เข้าสู่ระบบ';b.onclick=()=>window.syntheticLogin({credential:'synthetic'});el.append(b)}}}};`,
      }),
    );
    await page.goto(origin);
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await page.getByLabel('ข้อความทดลอง').fill('ช่วยคิดชื่องานสัมมนาให้หน่อย');
    await page.getByRole('button', { name: 'ส่งข้อความ' }).click();
    await expect(page.getByText('Engine: คำตอบจำลองจาก Desktop engine')).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
    await expect(page.getByLabel('ข้อความทดลอง')).toBeHidden();
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});
