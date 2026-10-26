import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { exportDocx, exportPdfHtml } from '../packages/harness-core/vendor/desktop/document-export.ts';
import { GARUDA_PNG } from '../packages/harness-core/vendor/desktop/garuda-image.ts';

// Synthetic drafts only. Layout follows Desktop's working layouts, not a certified agency form.
const memo = [
  '# บันทึกข้อความ',
  '',
  'ส่วนราชการ ฝ่ายสังเคราะห์ โทร. ๐ ๐๐๐๐ ๐๐๐๐',
  '',
  'ที่ สค ๐๐๐๑\tวันที่ ๑ มกราคม ๒๕๖๙',
  '',
  'เรื่อง ทดสอบการจัดหน้า',
  '',
  'เรียน ผู้อำนวยการสังเคราะห์',
  '',
  'ข้อความสังเคราะห์สำหรับตรวจการจัดหน้า',
  '',
  '(นายตัวอย่าง สังเคราะห์)',
].join('\n');
const parts = async (bytes: Uint8Array) => {
  const zip = await JSZip.loadAsync(bytes);
  // Thai word breaks (on by default) add zero-width spaces; compare the visible text.
  const read = async (name: string) => ((await zip.file(name)?.async('string')) || '').replace(/​/g, '');
  const headers = await Promise.all(
    Object.keys(zip.files)
      .filter((n) => /^word\/header\d*\.xml$/.test(n))
      .map(read),
  );
  return {
    document: await read('word/document.xml'),
    styles: await read('word/styles.xml'),
    headers: headers.join('\n'),
    media: Object.keys(zip.files).filter((n) => n.startsWith('word/media/') && n.endsWith('.png')),
  };
};
const paragraphAlignment = (xml: string, text: string) => {
  const paragraph = xml
    .replace(/​/g, '')
    .match(/<w:p(?: [^>]*)?>[\s\S]*?<\/w:p>/g)
    ?.find((candidate) => candidate.includes(text));
  assert.ok(paragraph, text);
  return paragraph.match(/<w:jc[^>]*w:val="([^"]+)"/)?.[1];
};

test('the Garuda is the pinned 800 × 800 original', () => {
  assert.equal(
    createHash('sha256').update(GARUDA_PNG).digest('hex'),
    'b04394193c54c754c53eb91d30df47adc3f745124ed241283a732f9b2e526be0',
  );
  const view = new DataView(GARUDA_PNG.buffer, GARUDA_PNG.byteOffset);
  assert.deepEqual([view.getUint32(16), view.getUint32(20)], [800, 800]);
});

test('a memo carries a 1.5 cm Garuda on its first page and the สารบรรณ margins', async () => {
  const output = await exportDocx(memo, { documentTool: 'memo' });
  assert.deepEqual(output.layout, { id: 'memo', font: 'TH Sarabun New', garudaHeightCm: 1.5 });
  const { document, headers, media, styles } = await parts(output.bytes);
  assert.equal(media.length, 1);
  assert.match(document, /<w:titlePg\/>/);
  assert.match(document, /w:top="1418" w:right="1134" w:bottom="1134" w:left="1701"/);
  // The memo title sits beside the emblem in the first-page header, not in the body.
  assert.match(headers, /บันทึกข้อความ/);
  assert.doesNotMatch(document, /บันทึกข้อความ/);
  assert.match(headers, /cx="540000"/);
  assert.match(styles, /TH Sarabun New/);
  // ที่ and วันที่ share one line with a tab stop at the half width.
  assert.match(document, /<w:tab w:val="left" w:pos="4535"\/>/);
  assert.equal(output.fieldsNeedUpdate, true);
});

test('an external letter carries a 3 cm Garuda, and either can be left out', async () => {
  const letter = await exportDocx('หน่วยงานสังเคราะห์\n\nเรื่อง ทดสอบ\n\nเรียน ผู้รับสังเคราะห์\n\nข้อความ', {
    documentTool: 'letter',
  });
  assert.deepEqual(letter.layout, { id: 'letter', font: 'TH SarabunPSK', garudaHeightCm: 3 });
  const { headers, media } = await parts(letter.bytes);
  assert.equal(media.length, 1);
  assert.match(headers, /cx="1080000"/);
  const none = await exportDocx(memo, { documentTool: 'memo', garuda: 'none' });
  assert.equal(none.layout.garudaHeightCm, undefined);
  assert.deepEqual((await parts(none.bytes)).media, []);
});

test('TOR, proposals and minutes have no automatic Garuda; general drafts keep the report page', async () => {
  for (const id of ['tor', 'project', 'minutes']) {
    const output = await exportDocx('# ขอบเขตของงาน\n\n## ๑. ความเป็นมา\n\nข้อความ', { documentTool: id });
    assert.equal(output.layout.garudaHeightCm, undefined);
    const { document, media } = await parts(output.bytes);
    assert.deepEqual(media, []);
    assert.match(document, /w:left="1701"/);
  }
  const general = await exportDocx('ข้อความทั่วไป');
  assert.match((await parts(general.bytes)).document, /w:left="1440"/);
  assert.equal(general.fieldsNeedUpdate, false);
  await assert.rejects(exportDocx(memo, { documentTool: 'memo', font: 'Arial' }), /INVALID_EXPORT_FONT/);
  await assert.rejects(exportDocx('ก'.repeat(200001)), /DOCUMENT_TOO_LARGE/);
});

test('Thai Word settings and document roles keep TOR front matter left-aligned', async () => {
  const tor = await exportDocx('# ร่าง TOR\n\nหน่วยงานสังเคราะห์\n\n## ๑. วัตถุประสงค์\n\nสาระจากต้นทาง', {
    documentTool: 'tor',
  });
  const output = await parts(tor.bytes);
  assert.match(output.styles, /w:eastAsia="th-TH"/);
  assert.equal(paragraphAlignment(output.document, 'ร่าง TOR'), 'center');
  assert.equal(paragraphAlignment(output.document, 'หน่วยงานสังเคราะห์'), 'left');
  assert.equal(paragraphAlignment(output.document, 'สาระจากต้นทาง'), 'left');

  const minutes = await exportDocx(
    '# รายงานการประชุม\n\nชื่อการประชุม สังเคราะห์\n\nครั้งที่ [รอยืนยัน: ครั้งที่]\n\nผู้มาประชุม [รอยืนยัน: รายชื่อ]',
    { documentTool: 'minutes' },
  );
  const minutesOutput = await parts(minutes.bytes);
  assert.equal(paragraphAlignment(minutesOutput.document, 'ชื่อการประชุม'), 'center');
  assert.equal(paragraphAlignment(minutesOutput.document, 'ครั้งที่'), 'center');
  assert.notEqual(paragraphAlignment(minutesOutput.document, 'ผู้มาประชุม'), 'center');
});

test('the PDF page shows the letterhead and escapes draft text', () => {
  const html = exportPdfHtml(memo + '\n\n<img src=x onerror=alert(1)>', {
    documentTool: 'memo',
    fontFaces: '@font-face{font-family:"TH Sarabun New"}',
  });
  assert.match(html, /<div class="letterhead memo"><img alt="ตราครุฑ" src="data:image\/png;base64,/);
  assert.match(html, /height:1\.5cm/);
  assert.match(html, /@page\{size:A4;margin:2\.5cm 2cm 2cm 3cm\}/);
  assert.ok(html.indexOf('@font-face{font-family:"TH Sarabun New"}') < html.indexOf('STeP Fallback'));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(exportPdfHtml('# ขอบเขตของงาน', { documentTool: 'tor' }), /ตราครุฑ/);
});

test('the PDF page keeps TOR agency blocks left-aligned', () => {
  const html = exportPdfHtml('# ร่าง TOR\n\nหน่วยงานสังเคราะห์\n\n## ๑. วัตถุประสงค์\n\nสาระจากต้นทาง', {
    documentTool: 'tor',
  });
  assert.match(html, /class="block title" style="text-align:center;"/);
  assert.match(html, /class="block front" style="text-align:left;"/);
  assert.match(html, /class="block body" style="text-align:left;text-indent:2\.5cm;text-align:justify;"/);
});
