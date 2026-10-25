import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
// Tools live under "เครื่องมือ" in the sidebar, as on Desktop. A tool's name may carry a status badge (ทดลอง).
async function menu(page: Page, name: string) {
  const open = page.getByRole('button', { name: 'เปิดเมนู', exact: true });
  if (await open.isVisible()) await open.click();
  await page
    .getByRole('navigation', { name: 'เครื่องมือ' })
    .getByRole('button', { name: new RegExp('^' + name) })
    .click();
}
async function theme(page: Page, label: 'สว่าง' | 'มืด' | 'ตามระบบ') {
  await page.getByRole('button', { name: 'เมนู STeP', exact: true }).click();
  await page.getByRole('menuitemradio', { name: label, exact: true }).click();
}
test('login clearly separates unconfigured access from the synthetic preview', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /พื้นที่ทำงานของคุณ/ })).toBeVisible();
  await expect(page.getByText('ระบบยังไม่เปิดให้เข้าใช้งานจริง')).toBeVisible();
  await page.getByRole('button', { name: 'ดูตัวอย่างหน้าจอ' }).click();
  await expect(page.getByText('ตัวอย่าง · ไม่ใช่ข้อมูลจริง')).toBeVisible();
});
test('employee can create a private conversation, review consent and receive a result', async ({ page }) => {
  await page.goto('/?demo=1');
  // As on Desktop, typing on the home screen starts a private task; consent still comes before any AI call.
  await expect(page.getByRole('heading', { name: /ให้ AI ร่างงานหนัก/ })).toBeVisible();
  await page.getByRole('textbox', { name: 'ข้อความถึง AI' }).fill('ช่วยวางโครงร่างเอกสารตัวอย่าง');
  await page.getByRole('button', { name: 'ส่งข้อความ' }).click();
  const consent = page.getByRole('dialog');
  await expect(consent.getByRole('heading', { name: 'ข้อมูลที่จะให้ AI อ่าน' })).toBeVisible();
  await expect(consent.getByText('ความจำ · รูปแบบคำตอบ')).toBeVisible();
  await consent.getByRole('button', { name: 'เริ่มงาน', exact: true }).click();
  await expect(page.getByText('นี่คือคำตอบตัวอย่างสำหรับตรวจหน้าจอครับ', { exact: false })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole('button', { name: 'ใช้เป็นร่าง' })).toBeVisible();
  await page.getByRole('button', { name: 'ใช้เป็นร่าง' }).click();
  await expect(page.getByRole('textbox', { name: 'ร่างเอกสาร' })).toHaveValue(/นี่คือคำตอบตัวอย่าง/);
  await page.getByRole('button', { name: 'บันทึก', exact: true }).click();
  await expect(page.getByText('ร่าง Markdown · บันทึกแล้ว')).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await expect(page.getByLabel('รูปแบบไฟล์', { exact: true })).toHaveValue('docx');
  await page.getByRole('button', { name: 'ส่งออก', exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toMatch(/\.docx$/);
  const archive = await JSZip.loadAsync(await readFile((await file.path())!));
  expect(await archive.file('word/document.xml')!.async('string')).toContain('นี่คือคำตอบตัวอย่าง');
});
test('receipt flow keeps the original, asks before OCR and saves an edited review', async ({ page }) => {
  await page.goto('/?demo=1');
  await menu(page, 'ตรวจใบเสร็จ AFP');
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 700;
    canvas.height = 900;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 700, 900);
    ctx.fillStyle = 'black';
    ctx.font = '24px sans-serif';
    ctx.fillText('SYNTHETIC RECEIPT - TEST ONLY', 30, 100);
    ctx.fillText('Total 100.00', 30, 200);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('เลือกไฟล์อัปโหลด', { exact: true }).setInputFiles({
    name: 'synthetic-receipt.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image, 'base64'),
  });
  await expect(page.getByRole('button', { name: 'เริ่มตรวจใบเสร็จ', exact: true })).toBeEnabled({
    timeout: 20000,
  });
  await page.getByRole('button', { name: 'เริ่มตรวจใบเสร็จ', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/Google Gemini API/)).toBeVisible();
  await page.getByRole('button', { name: 'ยืนยันและเริ่มตรวจ' }).click();
  await expect(page.getByRole('heading', { name: 'ใบเสร็จประเภทไหน' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: 'ดาวน์โหลดต้นฉบับ' })).toBeVisible();
  await page.getByLabel('แก้ไข วันที่', { exact: true }).fill('21/10/2026');
  await expect(page.getByRole('button', { name: 'บันทึกผลตรวจ', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: /ตรวจข้อมูลที่แสดงกับต้นฉบับ/ }).check();
  await page.getByRole('button', { name: 'บันทึกผลตรวจ', exact: true }).click();
  await expect(page.getByRole('button', { name: 'บันทึกผลตรวจแล้ว' })).toBeVisible();
  await page.locator('.receipt-history button').first().click();
  await expect(page.getByLabel('แก้ไข วันที่', { exact: true })).toHaveValue('21/10/2026');
});
test('private memory can be edited and deleted without exposing JSON', async ({ page }) => {
  await page.goto('/?demo=1');
  await menu(page, 'ความจำ');
  await page.getByRole('button', { name: 'เพิ่มความจำ', exact: true }).click();
  await page.getByRole('textbox', { name: 'ชื่อความจำ' }).fill('รูปแบบเอกสารตัวอย่าง');
  await page.getByRole('textbox', { name: 'สิ่งที่ต้องการจำ' }).fill('ชอบสรุปเป็นสามข้อและมีขั้นตอนถัดไป');
  await page.getByRole('button', { name: 'ยืนยันและบันทึก' }).click();
  await expect(page.getByRole('heading', { name: 'รูปแบบเอกสารตัวอย่าง' })).toBeVisible();
  await page.getByRole('button', { name: 'ลบ รูปแบบเอกสารตัวอย่าง', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'ลบความจำ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'รูปแบบเอกสารตัวอย่าง' })).toHaveCount(0);
});
test('upload is private and does not immediately send a document to AI', async ({ page }) => {
  await page.goto('/?demo=1');
  await menu(page, 'เอกสาร');
  await page.locator('input[type=file]').setInputFiles({
    name: 'synthetic-notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('ข้อมูลสังเคราะห์สำหรับทดสอบเท่านั้น'),
  });
  await expect(page.getByRole('heading', { name: 'synthetic-notes.txt' })).toBeVisible();
  await expect(page.getByText('เก็บไฟล์แล้ว · ยังไม่ได้ส่งให้ AI')).toBeVisible();
  await page.getByRole('button', { name: 'เตรียมให้ AI ค้น' }).click();
  await expect(page.getByRole('dialog').getByText(/ใช้วงเงิน AI ขององค์กร/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'ยืนยันและเริ่มอ่าน' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('เริ่มอ่านเอกสารแล้ว คุณเปิดงานอื่นต่อได้')).toBeVisible();
});
test('settings explain paused Google access and support resuming it', async ({ page }) => {
  await page.goto('/?demo=1');
  const open = page.getByRole('button', { name: 'เปิดเมนู', exact: true });
  if (await open.isVisible()) await open.click();
  await page.getByRole('button', { name: 'การตั้งค่า', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'หมวดการตั้งค่า' })
    .getByRole('button', { name: 'Google Workspace', exact: true })
    .click();
  await page.getByRole('button', { name: 'เชื่อมต่อ Google', exact: true }).click();
  await expect(page.getByRole('button', { name: 'หยุดการใช้ข้อมูลบัญชี', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'หยุดการใช้ข้อมูลบัญชี', exact: true }).click();
  await expect(page.getByText('หยุดการใช้งานไว้', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'กลับมาใช้ข้อมูลบัญชี', exact: true }).click();
  await expect(page.getByRole('button', { name: 'หยุดการใช้ข้อมูลบัญชี', exact: true })).toBeVisible();
});
test('admin can review a free model trial, consent once and clear its temporary reply', async ({ page }) => {
  const providerRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'openrouter.ai') providerRequests.push(request.url());
  });
  await page.goto('/?demo=1');
  const open = page.getByRole('button', { name: 'เปิดเมนู', exact: true });
  if (await open.isVisible()) await open.click();
  await page.getByRole('button', { name: 'การตั้งค่า', exact: true }).click();
  await page.getByRole('button', { name: 'เชื่อมต่อ AI', exact: true }).click();
  const trial = page.getByRole('region', { name: 'ทดลอง OpenRouter Free สำหรับผู้ดูแล' });
  await expect(trial.getByText('ตัวอย่างหน้าจอเท่านั้น · ไม่ได้เรียก OpenRouter จริง')).toBeVisible();
  const send = trial.getByRole('button', { name: 'ส่งทดลองโมเดลฟรี', exact: true });
  await expect(send).toBeDisabled();
  await trial.getByRole('button', { name: 'โหลดรายการโมเดลฟรี', exact: true }).click();
  await expect(trial.getByRole('combobox', { name: 'โมเดลฟรี', exact: true })).toHaveValue(
    'synthetic/example:free',
  );
  const consent = trial.getByRole('checkbox');
  await consent.check();
  await trial
    .getByRole('textbox', { name: 'ข้อความทดลอง (ข้อมูลสมมติ)', exact: true })
    .fill('ลองวางแผนประชุมตัวอย่าง');
  await expect(consent).not.toBeChecked();
  await expect(send).toBeDisabled();
  await consent.check();
  await send.click();
  await expect(
    trial.getByText('คำตอบจำลองสำหรับทดลองหน้าจอ OpenRouter เท่านั้น', { exact: true }),
  ).toBeVisible();
  await expect(send).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(accessibility.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual(
    [],
  );
  await trial.getByRole('button', { name: 'ล้างผลการทดลอง', exact: true }).click();
  await expect(
    trial.getByText('คำตอบจำลองสำหรับทดลองหน้าจอ OpenRouter เท่านั้น', { exact: true }),
  ).toHaveCount(0);
  expect(providerRequests).toEqual([]);
});
test('main screens fit the viewport and pass essential accessibility checks', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/?demo=1');
  for (const tab of ['ศูนย์รวม Skill', 'เอกสาร', 'ความจำ', 'ตรวจใบเสร็จ AFP']) {
    await menu(page, tab);
    await expect(page.getByRole('heading', { name: tab, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
  }
});
test('dark theme keeps task, notice and receipt states readable', async ({ page }) => {
  test.setTimeout(90000);
  const axe = async () =>
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    }));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  // The sign-in screen sits on a flat theme surface, so its text contrast is measurable in dark mode too.
  expect(await axe()).toEqual([]);
  await page.goto('/?demo=1');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
  await page.getByRole('textbox', { name: 'ข้อความถึง AI' }).fill('งานสังเคราะห์สำหรับตรวจธีมมืด');
  await page.getByRole('button', { name: 'ส่งข้อความ' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'เริ่มงาน', exact: true }).click();
  await expect(page.getByText('นี่คือคำตอบตัวอย่างสำหรับตรวจหน้าจอครับ', { exact: false })).toBeVisible({
    timeout: 15000,
  });
  const open = page.getByRole('button', { name: 'เปิดเมนู', exact: true });
  if (await open.isVisible()) await open.click();
  // The opened task carries the selected state and its active marker.
  await expect(page.locator('.session-open[aria-current="true"]')).toBeVisible();
  expect(await axe()).toEqual([]);
  if (await open.isVisible()) await page.getByRole('button', { name: 'ปิดเมนู', exact: true }).click();
  await menu(page, 'เอกสาร');
  await page.locator('input[type=file]').setInputFiles({
    name: 'synthetic-dark.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('ข้อมูลสังเคราะห์'),
  });
  await expect(page.locator('.success-notice')).toBeVisible();
  expect(await axe()).toEqual([]);
  await menu(page, 'ตรวจใบเสร็จ AFP');
  // Pages load on first open; upload only once the receipt page itself is showing.
  await expect(page.getByRole('heading', { name: 'ตรวจใบเสร็จ AFP', exact: true })).toBeVisible();
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 800;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 600, 800);
    ctx.fillStyle = 'black';
    ctx.fillText('SYNTHETIC RECEIPT - TEST ONLY', 30, 100);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('เลือกไฟล์อัปโหลด', { exact: true }).setInputFiles({
    name: 'synthetic-dark-receipt.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image, 'base64'),
  });
  await expect(page.getByRole('button', { name: 'เริ่มตรวจใบเสร็จ', exact: true })).toBeEnabled({
    timeout: 20000,
  });
  await page.getByRole('button', { name: 'เริ่มตรวจใบเสร็จ', exact: true }).click();
  await page.getByRole('button', { name: 'ยืนยันและเริ่มตรวจ' }).click();
  await expect(page.locator('.check-status.found').first()).toBeVisible({ timeout: 15000 });
  expect(await axe()).toEqual([]);
});
test('profile, assistant and answer style follow Desktop and are disclosed before AI use', async ({
  page,
}) => {
  await page.goto('/?demo=1');
  const open = page.getByRole('button', { name: 'เปิดเมนู', exact: true });
  if (await open.isVisible()) await open.click();
  await page.getByRole('button', { name: 'การตั้งค่า', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'โปรไฟล์และทีม' })).toBeVisible();
  await page.getByRole('textbox', { name: 'ชื่อเรียกของคุณ', exact: true }).fill('ต้น');
  await page.getByRole('combobox', { name: 'ทีมหลัก', exact: true }).selectOption('afp');
  await page.getByRole('textbox', { name: 'ชื่อผู้ช่วย', exact: true }).fill('ตุ๊ดตู่');
  await page.getByRole('radio', { name: /คมคาย \(Witty\)/ }).click();
  await expect(
    page.getByText('ก่อนส่ง ตรวจให้ครบสามจุด: เนื้อหา ผู้รับ และไฟล์แนบ แล้วค่อยกดส่ง'),
  ).toBeVisible();
  await page.getByRole('radio', { name: /ภาษาเหนือ/ }).click();
  await page.getByRole('button', { name: 'เปลี่ยนรูป', exact: true }).click();
  await page.getByRole('radio', { name: 'ภาพที่ 3', exact: true }).click();
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
  await page.getByRole('button', { name: 'บันทึกโปรไฟล์และผู้ช่วย' }).click();
  await expect(page.getByText('บันทึกโปรไฟล์และผู้ช่วยแล้ว')).toBeVisible();
  if (await open.isVisible()) await open.click();
  const sidebar = page.getByRole('complementary', { name: 'แถบงาน' });
  await expect(sidebar.getByText('ผู้ช่วย ตุ๊ดตู่ · ทีม AFP')).toBeVisible();
  await expect(sidebar.locator('.profile .avatar-badge img')).toBeVisible();
  await page.getByRole('button', { name: 'เริ่มงานใหม่', exact: true }).first().click();
  await expect(page.getByText('สวัสดีครับ คุณต้น · บัญชี การเงิน และจัดซื้อ')).toBeVisible();
  await expect(page.getByText('ลองงานแรกของทีม บัญชี การเงิน และจัดซื้อ')).toBeVisible();
  await page.getByRole('textbox', { name: 'ข้อความถึง AI' }).fill('ช่วยสรุปงานตัวอย่าง');
  await page.getByRole('button', { name: 'ส่งข้อความ' }).click();
  await expect(page.getByRole('dialog').getByText('ชื่อเรียก ทีม และสไตล์การตอบที่คุณตั้งไว้')).toBeVisible();
});
test('memories record their Desktop type and lifetime', async ({ page }) => {
  await page.goto('/?demo=1');
  await menu(page, 'ความจำ');
  await page.getByRole('button', { name: 'เพิ่มความจำ', exact: true }).click();
  await page.getByRole('textbox', { name: 'ชื่อความจำ' }).fill('โครงการตัวอย่าง');
  await page.getByRole('textbox', { name: 'สิ่งที่ต้องการจำ' }).fill('งานสังเคราะห์สำหรับทดสอบ');
  await page.getByRole('combobox', { name: 'ประเภท', exact: true }).selectOption('project');
  await page.getByRole('spinbutton', { name: /อายุความจำ/ }).fill('30');
  await page.getByRole('button', { name: 'ยืนยันและบันทึก' }).click();
  const card = page.locator('.memory-card', { hasText: 'โครงการตัวอย่าง' });
  await expect(card.getByText('บริบทโครงการ')).toBeVisible();
  await expect(card.getByText('พิมพ์เอง · ใช้ได้อีก 30 วัน')).toBeVisible();
});
