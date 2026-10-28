import { test, expect } from '@playwright/test';

// Cloud Workspace mode (ADR 0001 phase 3b) in the real screens: playwright.config.ts serves the app built for the
// Gateway on :5175 next to a test Gateway whose runtime streams a scripted answer. No AI provider or Google service.
const APP = 'http://127.0.0.1:5175';
const QUESTION = 'ติดต่อฝ่ายบุคคลช่องทางไหน';

/** A credential the test Gateway accepts; the app only reads who and until when from it. */
function credential() {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part({ sub: 'e2e-employee', email: 'e2e@step.example', exp: Math.floor(Date.now() / 1000) + 3600 })}.synthetic`;
}

test.beforeEach(({ isMobile }) => test.skip(isMobile, 'one viewport is enough for the Gateway path'));

test('the same screens run on the Gateway: the answer streams, survives a reload, and missing tools are hidden', async ({
  page,
}) => {
  const external: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      external.push(url.href);
      return route.abort();
    }
    return route.continue();
  });
  await page.addInitScript((token) => sessionStorage.setItem('step-gateway-credential', token), credential());
  await page.goto(APP + '/');

  // Only what the Gateway serves is offered.
  const tools = page.getByRole('navigation', { name: 'เครื่องมือ' });
  await expect(tools.getByRole('button', { name: /^ค้นงานเก่า/ })).toBeVisible();
  for (const hidden of [
    'ความจำ',
    'เอกสาร',
    'ตรวจใบเสร็จ',
    'ศูนย์รวม Skill',
    'เครื่องมือร่างเอกสาร',
    'สื่อภายใน',
  ])
    await expect(tools.getByRole('button', { name: new RegExp('^' + hidden) })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'การตั้งค่า', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'เลือกเอกสาร' })).toHaveCount(0);

  await page.getByRole('textbox', { name: 'ข้อความถึง AI' }).fill(QUESTION);
  await page.getByRole('button', { name: 'ส่งข้อความ' }).click();
  const consent = page.getByRole('dialog');
  await expect(consent.getByText(/STeP Cloud Workspace/)).toBeVisible();
  await consent.getByRole('button', { name: 'เริ่มงาน', exact: true }).click();

  // The answer streams in while the runtime is still working…
  await expect(page.getByText('ติดต่อฝ่ายบุคคล', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('(คำตอบสังเคราะห์)')).toHaveCount(0);

  // …the tab is reloaded mid-answer, the task is opened again, and the finished answer is there.
  await page.reload();
  await page
    .getByRole('button', { name: new RegExp(QUESTION) })
    .first()
    .click();
  await expect(page.getByText('(คำตอบสังเคราะห์)', { exact: false })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: 'ใช้เป็นร่าง' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'บันทึกความจำ' })).toHaveCount(0);

  // A second question is stopped from the chat while it streams; no answer follows.
  await page.getByRole('textbox', { name: 'ข้อความถึง AI' }).fill('ลาพักผ่อนได้กี่วัน');
  await page.getByRole('button', { name: 'ส่งข้อความ' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'เริ่มงาน', exact: true }).click();
  const stop = page.getByRole('button', { name: 'หยุดงาน' });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(stop).toHaveCount(0, { timeout: 10000 });
  // The scripted answer would finish within four seconds; after six there is still only the first one.
  await page.waitForTimeout(6000);
  await expect(page.getByText('(คำตอบสังเคราะห์)', { exact: false })).toHaveCount(1);

  expect(external, 'nothing left the machine').toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('without a credential the sign-in screen offers Google’s own button, not the Supabase one', async ({
  page,
}) => {
  await page.route('**/*', (route) =>
    ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  );
  await page.goto(APP + '/');
  await expect(page.getByRole('heading', { name: /พื้นที่ทำงานของคุณ/ })).toBeVisible();
  // Google's script is blocked here, so the button cannot load; the app says so instead of offering a dead button.
  await expect(page.getByRole('button', { name: 'ลงชื่อเข้าใช้ด้วย Google' })).toHaveCount(0);
  await expect(page.getByText('ระบบยังไม่เปิดให้เข้าใช้งานจริง')).toHaveCount(0);
});
