import { test, expect, type Page } from '@playwright/test';

async function openMenu(page: Page) {
  const button = page.getByRole('button', { name: 'เปิดเมนู', exact: true });
  if (await button.isVisible()) await button.click();
}
async function tool(page: Page, name: string) {
  await openMenu(page);
  await page.getByRole('navigation', { name: 'เครื่องมือ' }).getByRole('button', { name }).click();
}
async function prepare(page: Page, title: string) {
  await tool(page, 'เครื่องมือร่างเอกสาร');
  await page.getByRole('button', { name: 'ร่างบันทึกข้อความ', exact: true }).click();
  await page.getByRole('textbox', { name: 'เรื่อง', exact: true }).fill(title);
  await page.getByRole('button', { name: 'เตรียมร่างในบทสนทนา' }).click();
  await expect(page.getByRole('textbox', { name: 'ร่างเอกสาร', exact: true })).toHaveValue(new RegExp(title));
}
async function openTask(page: Page, index: number) {
  await openMenu(page);
  await page.locator('.session-open').nth(index).click();
  const draft = page.getByRole('textbox', { name: 'ร่างเอกสาร', exact: true });
  if (!(await draft.isVisible())) await page.getByRole('button', { name: 'เปิดร่าง', exact: true }).click();
  return draft;
}

test('unsaved drafts survive tools and task switching without browser storage', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(r.url()).hostname)) external.push(r.url());
  });
  await page.goto('/?demo=1');
  await prepare(page, 'SYNTHETIC DRAFT A');
  await page.getByRole('textbox', { name: 'ร่างเอกสาร', exact: true }).fill('PRIVATE UNSAVED TEXT A');
  await tool(page, 'ความจำ');
  await expect(await openTask(page, 0)).toHaveValue('PRIVATE UNSAVED TEXT A');
  await prepare(page, 'SYNTHETIC DRAFT B');
  await page.getByRole('textbox', { name: 'ร่างเอกสาร', exact: true }).fill('PRIVATE UNSAVED TEXT B');
  await expect(await openTask(page, 1)).toHaveValue('PRIVATE UNSAVED TEXT A');
  await expect(await openTask(page, 0)).toHaveValue('PRIVATE UNSAVED TEXT B');
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain('PRIVATE UNSAVED TEXT');
  expect(external).toEqual([]);
});

test('dirty drafts protect reload on other pages and explicit logout can be cancelled', async ({ page }) => {
  await page.goto('/?demo=1');
  await prepare(page, 'SYNTHETIC GUARDED DRAFT');
  await page.getByRole('textbox', { name: 'ร่างเอกสาร', exact: true }).fill('KEEP THIS UNSAVED DRAFT');
  await tool(page, 'ความจำ');
  expect(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  await page.getByRole('button', { name: 'เมนู STeP', exact: true }).click();
  await page.getByRole('menuitem', { name: 'ออกจากระบบ', exact: true }).click();
  const guard = page.getByRole('dialog', { name: 'มีร่างที่ยังไม่บันทึก' });
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: 'กลับไปทำงาน', exact: true }).click();
  await expect(await openTask(page, 0)).toHaveValue('KEEP THIS UNSAVED DRAFT');
  await page.getByRole('button', { name: 'บันทึก', exact: true }).click();
  await expect(page.getByText('ร่าง Markdown · บันทึกแล้ว')).toBeVisible();
  expect(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(false);
});
