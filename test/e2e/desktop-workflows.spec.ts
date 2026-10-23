import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
async function menu(page: Page, name: string) {
  const open = page.getByRole('button', { name: 'เปิดเมนู', exact: true });
  if (await open.isVisible()) await open.click();
  await page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name, exact: true }).click();
}
test('document form creates an editable private draft and waits for AI consent', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (!new URL(r.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/)) external.push(r.url());
  });
  await page.goto('/?demo=1');
  await menu(page, 'ร่างเอกสาร');
  await page.getByRole('button', { name: 'ร่างบันทึกข้อความ', exact: true }).click();
  await page.getByRole('textbox', { name: 'เรื่อง', exact: true }).fill('โครงการสังเคราะห์');
  await page.getByRole('button', { name: 'เตรียมร่างในบทสนทนา' }).click();
  await expect(page.getByRole('textbox', { name: 'ข้อความถึง AI' })).toHaveValue(/USER_INPUT/);
  const draft = page.getByRole('textbox', { name: 'ร่างเอกสาร', exact: true });
  await expect(draft).toHaveValue(/โครงการสังเคราะห์/);
  await expect(page.getByRole('button', { name: 'ใช้เป็นร่าง' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await draft.fill('# หัวเรื่อง\n\n- ข้อแรก\n\n| รายการ | จำนวน |\n| --- | --- |\n| ทดสอบ | 2 |');
  await page.getByLabel('รูปแบบ Word', { exact: true }).selectOption('saraban');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Word (.docx)', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await downloaded).path())!));
  const xml = await zip.file('word/document.xml')!.async('string');
  expect(xml).toContain('หัวเรื่อง');
  expect(xml).toContain('<w:tbl>');
  expect(xml).toContain('Heading1');
  expect(xml).toContain('w:left="1701"');
  await page.getByRole('button', { name: 'ปิดร่าง', exact: true }).click();
  await page.getByRole('button', { name: 'ส่งข้อความ', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'ข้อมูลที่จะให้ AI อ่าน' }),
  ).toBeVisible();
  expect(external).toEqual([]);
});
test('media studio keeps prompt preparation local and offers no fabricated image result', async ({
  page,
}) => {
  await page.goto('/?demo=1');
  await menu(page, 'สื่อภายใน');
  await expect(page.getByRole('button', { name: 'คัดลอก Prompt', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'หัวข้อ', exact: true }).fill('แบ่งปันไอเดียในทีม');
  await page
    .getByRole('textbox', { name: 'ข้อมูลต้นเรื่อง', exact: true })
    .fill('ภาพประกอบสังเคราะห์สำหรับทดสอบ');
  await page
    .getByRole('textbox', { name: 'ข้อความบนสื่อ / ขั้นตอนที่ยืนยันแล้ว', exact: true })
    .fill('แบ่งปันไอเดียและช่วยกัน');
  await expect(page.getByRole('button', { name: 'คัดลอก Prompt', exact: true })).toBeEnabled();
  await expect(page.getByText('ภาพตัวอย่างโครงวาง · ยังไม่ได้สร้างภาพ', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'บันทึก Prompt', exact: true }).click();
  const contents = await readFile((await (await download).path())!, 'utf8');
  expect(contents).toContain('#FFC709');
  expect(contents).toContain('Never generate, redraw or imitate ANY logo');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('Skill details retain source version and can be searched by command', async ({ page }) => {
  await page.goto('/?demo=1');
  await menu(page, 'Skill');
  await page.getByRole('textbox', { name: 'ค้นหา Skill', exact: true }).fill('tor-government');
  await expect(page.locator('.skill-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'รายละเอียด ร่าง TOR ภาครัฐ', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('ต้นทาง: demo', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByText('อ่านคำแนะนำ Skill', { exact: true }).click();
  await expect(
    page.getByRole('dialog').getByText('คำแนะนำตัวอย่างเท่านั้น ไม่ใช่เอกสารองค์กร', { exact: true }),
  ).toBeVisible();
});
test('history search finds draft contents without sending a new AI request', async ({ page }) => {
  await page.goto('/?demo=1');
  await menu(page, 'ร่างเอกสาร');
  await page
    .getByRole('textbox', { name: 'ชื่อเอกสาร / ชื่อโครงการ', exact: true })
    .fill('needle-synthetic-50%');
  await page.getByRole('button', { name: 'เตรียมร่างในบทสนทนา' }).click();
  await expect(page.getByRole('textbox', { name: 'ร่างเอกสาร', exact: true })).toHaveValue(
    /needle-synthetic/,
  );
  await menu(page, 'ค้นงานเก่า');
  await page.getByRole('textbox', { name: 'คำค้นงานเก่า', exact: true }).fill('needle-synthetic-50%');
  await page.getByRole('button', { name: 'ค้นหา', exact: true }).click();
  await expect(page.locator('.history-results button')).toHaveCount(1);
  await page.locator('.history-results button').click();
  await page
    .locator('.conversation-heading')
    .getByRole('button', { name: 'ร่างเอกสาร', exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: 'ร่างเอกสาร', exact: true })).toHaveValue(
    /needle-synthetic/,
  );
  await expect(page.getByRole('textbox', { name: 'ข้อความถึง AI', exact: true })).toHaveValue('');
});
test('Desktop reference is searchable and dark theme remains accessible after reload', async ({ page }) => {
  await page.goto('/help?demo=1');
  await expect(page.getByRole('heading', { name: 'รู้จัก STeP AI', exact: true })).toBeVisible();
  await expect(page.locator('.feature-list article')).toHaveCount(32);
  await page.getByRole('textbox', { name: 'ค้นความสามารถ', exact: true }).fill('Vault');
  await expect(page.getByRole('heading', { name: 'Vault และบัญชีเว็บไซต์', exact: true })).toBeVisible();
  await page.getByLabel('ธีมหน้าจอ', { exact: true }).selectOption('dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('command search selects a page and desktop rail can collapse', async ({ page }, info) => {
  await page.goto('/?demo=1');
  await expect(page.getByRole('heading', { name: 'วันนี้อยากให้ช่วยเรื่องอะไร', exact: true })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog').getByRole('textbox', { name: 'คำค้น', exact: true }).fill('สื่อภายใน');
  await page.getByRole('dialog').getByRole('button', { name: 'สื่อภายใน', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'สื่อภายใน', exact: true })).toBeVisible();
  if (info.project.name === 'desktop') {
    await page.getByRole('button', { name: 'ย่อแถบเมนู', exact: true }).click();
    await expect(page.locator('.sidebar')).toHaveCSS('width', '76px');
    await page.getByRole('button', { name: 'ขยายแถบเมนู', exact: true }).click();
  }
});
test('new workflow pages fit the viewport and pass accessibility checks in both themes', async ({ page }) => {
  await page.goto('/?demo=1');
  for (const name of ['ร่างเอกสาร', 'สื่อภายใน', 'Skill', 'ค้นงานเก่า']) {
    await menu(page, name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
    await page.getByLabel('ธีมหน้าจอ', { exact: true }).selectOption('dark');
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
    await page.getByLabel('ธีมหน้าจอ', { exact: true }).selectOption('light');
  }
});
