import { test, expect, type Page } from '@playwright/test';

// The storage pool banner in the real Cloud Workspace screens. playwright.config.ts serves the app on :5176 next
// to a test Gateway (:8797) whose pool usage is FAKE and fixed per synthetic employee
// (server/test/support/e2e-storage-gateway.ts). No filesystem quota, AI provider or Google service.
const APP = 'http://127.0.0.1:5176';
const SEEDED_QUESTION = 'งานเดิมก่อนพื้นที่เต็ม';
const SHOTS = 'test-results/storage-warnings';

function credential(sub: string) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part({ sub, email: `${sub}@step.example`, exp: Math.floor(Date.now() / 1000) + 3600 })}.synthetic`;
}

async function open(page: Page, sub: string) {
  const external: string[] = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      external.push(url.href);
      return route.abort();
    }
    return route.continue();
  });
  await page.addInitScript(
    (token) => sessionStorage.setItem('step-gateway-credential', token),
    credential(sub),
  );
  const status = page.waitForResponse((r) => r.url().endsWith('/api/storage') && r.ok());
  await page.goto(APP + '/');
  await expect(page.getByRole('textbox', { name: 'ข้อความถึง AI' })).toBeVisible();
  // Nothing about the pool is judged before its status has actually been read.
  await status;
  return external;
}

test.beforeEach(({ isMobile }) => test.skip(isMobile, 'one viewport is enough for the Gateway path'));

test('the banner stays hidden while the pool is fine, and turns amber, then red, as it fills', async ({
  browser,
}) => {
  /** Each synthetic employee in a separate browser context, as a separate person would be. */
  const as = async (sub: string) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    return { page, context, external: await open(page, sub) };
  };

  const ok = await as('e2e-storage-ok');
  await expect(ok.page.locator('.storage-banner')).toHaveCount(0);

  const w = await as('e2e-storage-warning');
  const warning = w.page.locator('.storage-banner.warning');
  await expect(warning).toBeVisible();
  await expect(warning).toHaveAttribute('role', 'status');
  await expect(warning.getByText('พื้นที่เก็บงานใช้ไปแล้ว 85%')).toBeVisible();
  const amber = await warning.evaluate((el) => getComputedStyle(el).borderTopColor);
  await w.page.screenshot({ path: `${SHOTS}/warning.png` });

  const c = await as('e2e-storage-critical');
  const critical = c.page.locator('.storage-banner.critical');
  await expect(critical).toBeVisible();
  await expect(critical).toHaveAttribute('role', 'alert');
  // Files (inodes) are the worse limit here: 96 % of the file allowance, 20 % of the bytes.
  await expect(critical.getByText('จำนวนไฟล์เกือบเต็มแล้ว (96%)')).toBeVisible();
  // Red, not the amber of a warning.
  expect(await critical.evaluate((el) => getComputedStyle(el).borderTopColor)).not.toBe(amber);
  await c.page.screenshot({ path: `${SHOTS}/critical.png` });

  for (const who of [ok, w, c]) {
    expect(who.external, 'nothing left the machine').toEqual([]);
    await who.context.close();
  }
});

test('a full pool says so, keeps earlier work readable, and refuses a new message with a clear notice', async ({
  page,
}) => {
  const external = await open(page, 'e2e-storage-full');
  const full = page.locator('.storage-banner.full');
  await expect(full).toBeVisible();
  await expect(full.getByText('พื้นที่เก็บงานเต็มแล้ว')).toBeVisible();
  await expect(full.getByText(/บันทึกงานใหม่และอัปโหลดไฟล์ไม่ได้/)).toBeVisible();
  await expect(full.getByText(/เปิดอ่าน ดาวน์โหลด และลบได้ตามปกติ/)).toBeVisible();

  // The task saved before the pool filled still opens with its answer.
  await page
    .getByRole('button', { name: new RegExp(SEEDED_QUESTION) })
    .first()
    .click();
  await expect(page.getByText('(คำตอบสังเคราะห์)', { exact: false })).toBeVisible({ timeout: 15000 });

  // A new message is refused before it reaches the Workspace, with the Thai explanation.
  await page.getByRole('textbox', { name: 'ข้อความถึง AI' }).fill('ข้อความใหม่หลังพื้นที่เต็ม');
  await page.getByRole('button', { name: 'ส่งข้อความ' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'เริ่มงาน', exact: true }).click();
  const notice = page.getByRole('alert').filter({ hasText: 'ยังบันทึกงานใหม่ไม่ได้' });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole('button', { name: 'จัดการเอกสาร' })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/full-refused.png` });
  // The earlier answer is still there after the refusal.
  await expect(page.getByText('(คำตอบสังเคราะห์)', { exact: false })).toBeVisible();
  expect(external, 'nothing left the machine').toEqual([]);
});
