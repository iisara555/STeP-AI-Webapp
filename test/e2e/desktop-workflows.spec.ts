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
test('document form creates an editable private draft and waits for AI consent', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (!new URL(r.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/)) external.push(r.url());
  });
  await page.goto('/?demo=1');
  await menu(page, 'เครื่องมือร่างเอกสาร');
  await page.getByRole('button', { name: 'ร่างบันทึกข้อความ', exact: true }).click();
  await page.getByRole('textbox', { name: 'เรื่อง', exact: true }).fill('โครงการสังเคราะห์');
  await page.getByRole('button', { name: 'เตรียมร่างในบทสนทนา' }).click();
  await expect(page.getByRole('textbox', { name: 'ข้อความถึง AI' })).toHaveValue(/USER_INPUT/);
  const draft = page.getByRole('textbox', { name: 'ร่างเอกสาร', exact: true });
  await expect(draft).toHaveValue(/โครงการสังเคราะห์/);
  await expect(page.getByRole('button', { name: 'ใช้เป็นร่าง' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await draft.fill(
    '# บันทึกข้อความ\n\nเรื่อง ทดสอบ\n\n## หัวเรื่อง\n\n- ข้อแรก\n\n| รายการ | จำนวน |\n| --- | --- |\n| ทดสอบ | 2 |',
  );
  // A memo starts on the สารบรรณ page with Thai page numbers and the 1.5 cm Garuda, as on Desktop.
  await page.getByRole('button', { name: 'ตั้งค่าส่งออก', exact: true }).click();
  await expect(page.getByLabel('การจัดหน้า', { exact: true })).toHaveValue('saraban');
  await expect(page.getByLabel('รูปแบบเลขหน้า', { exact: true })).toHaveValue('thai');
  await expect(page.getByLabel('ตราครุฑ', { exact: true })).toHaveValue('auto');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'ส่งออก', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await downloaded).path())!));
  const xml = (await zip.file('word/document.xml')!.async('string')).replace(/​/g, '');
  const header = (await zip.file('word/header1.xml')!.async('string')).replace(/​/g, '');
  expect(header).toContain('บันทึกข้อความ');
  expect(header).toContain('cx="540000"');
  expect(xml).toContain('หัวเรื่อง');
  expect(xml).toContain('<w:tbl>');
  expect(xml).toContain('Heading2');
  expect(xml).toContain('w:left="1701"');
  // The pinned TH Sarabun New faces are embedded, so the file opens the same on a computer without them.
  expect(Object.keys(zip.files).filter((n) => /^word\/fonts\/.+\.odttf$/.test(n))).toHaveLength(4);
  expect(await zip.file('word/settings.xml')!.async('string')).toContain('w:embedTrueTypeFonts w:val="1"');
  await expect(page.getByRole('status').getByText('ฝังฟอนต์ครบแล้ว', { exact: false })).toBeVisible();
  await expect(page.getByText('ตราครุฑสูง 1.5 ซม. (เฉพาะหน้าแรก)')).toBeVisible();
  await page.getByRole('tab', { name: 'หน้ากระดาษ', exact: true }).click();
  const sheet = page.frameLocator('iframe[title="ตัวอย่างหน้ากระดาษ"]');
  await expect(sheet.getByRole('img', { name: 'ตราครุฑ' })).toBeVisible();
  await expect(sheet.getByText('ทดสอบ', { exact: true }).first()).toBeVisible();
  await page.getByLabel('ตราครุฑ', { exact: true }).selectOption('none');
  await expect(sheet.getByRole('img', { name: 'ตราครุฑ' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'แก้ไข', exact: true }).click();
  // PDF goes through the browser's print dialog with the same A4 page; headless Chromium prints without a dialog.
  await page.getByLabel('รูปแบบไฟล์', { exact: true }).selectOption('pdf');
  await page.getByRole('button', { name: 'ส่งออก', exact: true }).click();
  await expect(page.getByText('เลือก “บันทึกเป็น PDF” ในหน้าพิมพ์', { exact: false })).toBeVisible();
  await expect(page.getByText('ไม่ใส่ตราครุฑ', { exact: true }).last()).toBeVisible();
  for (const mode of ['มืด', 'สว่าง'] as const) {
    await theme(page, mode);
    expect(
      (await new AxeBuilder({ page }).include('.artifact-pane').withTags(['wcag2a', 'wcag2aa']).analyze())
        .violations,
    ).toEqual([]);
  }
  await page.getByRole('button', { name: 'ปิดร่าง', exact: true }).click();
  await page.getByRole('button', { name: 'ส่งข้อความ', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'ข้อมูลที่จะให้ AI อ่าน' }),
  ).toBeVisible();
  expect(external).toEqual([]);
});
test('a drafted document lands in the workbench while the review stays in the conversation', async ({
  page,
}) => {
  await page.goto('/?demo=1');
  await menu(page, 'เครื่องมือร่างเอกสาร');
  await page.getByRole('button', { name: 'ร่างบันทึกข้อความ', exact: true }).click();
  await page.getByRole('textbox', { name: 'เรื่อง', exact: true }).fill('โครงการสังเคราะห์');
  await page.getByRole('button', { name: 'เตรียมร่างในบทสนทนา' }).click();
  await page.getByRole('button', { name: 'ปิดร่าง', exact: true }).click();
  await page.getByRole('button', { name: 'ส่งข้อความ', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'เริ่มงาน', exact: true }).click();
  await expect(page.getByText('ร่างเอกสารอยู่ในแผงผลงาน', { exact: false })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('ผลตรวจตัวอย่าง', { exact: false })).toBeVisible();
  const draft = page.getByRole('textbox', { name: 'ร่างเอกสาร', exact: true });
  await expect(draft).toHaveValue(/# ขอบเขตของงาน \(ตัวอย่าง\)/);
  await expect(draft).not.toHaveValue(/ผลตรวจตัวอย่าง|document_review/);
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
  await menu(page, 'ศูนย์รวม Skill');
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
  await menu(page, 'เครื่องมือร่างเอกสาร');
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
  await page.getByRole('button', { name: 'เปิดร่าง', exact: true }).click();
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
  await theme(page, 'มืด');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('command search selects a page and desktop rail can collapse', async ({ page }, info) => {
  await page.goto('/?demo=1');
  await expect(page.getByRole('heading', { name: /ให้ AI ร่างงานหนัก/ })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog').getByRole('textbox', { name: 'คำค้น', exact: true }).fill('สื่อภายใน');
  await page.getByRole('dialog').getByRole('button', { name: 'สื่อภายใน', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'สื่อภายใน', exact: true })).toBeVisible();
  if (info.project.name === 'desktop') {
    await page.getByRole('button', { name: 'ย่อแถบงาน', exact: true }).click();
    await expect(page.locator('.sidebar.rail')).toHaveCSS('width', '60px');
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
    await page.getByRole('button', { name: 'ขยายแถบงาน', exact: true }).click();
    await expect(page.locator('.sidebar.rail')).toHaveCount(0);
  }
});
test('new workflow pages fit the viewport and pass accessibility checks in both themes', async ({ page }) => {
  await page.goto('/?demo=1');
  for (const name of ['เครื่องมือร่างเอกสาร', 'สื่อภายใน', 'ศูนย์รวม Skill', 'ค้นงานเก่า']) {
    await menu(page, name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
    await theme(page, 'มืด');
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
    await theme(page, 'สว่าง');
  }
});
