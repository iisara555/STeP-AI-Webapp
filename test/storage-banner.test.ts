// The Cloud Workspace storage banner: hidden while the pool is fine or its usage is unknown, amber from 80 %,
// red from 95 %, and a full-pool message saying new saves fail but existing work stays. Rendered to static markup;
// no browser and no Gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { errorView } from '../packages/harness-core/src/index.ts';
import { noticeHasAction } from '../web/src/notice-action.ts';
import { StorageBanner } from '../web/src/StorageBanner.tsx';
import { storageBanner, type StorageStatus } from '../web/src/storage.ts';

const at = (level: string, bytesPercent: number, inodesPercent = 1): StorageStatus =>
  ({
    state: 'available',
    level,
    bytesPercent,
    inodesPercent,
    worst: inodesPercent > bytesPercent ? 'inodes' : 'bytes',
  }) as StorageStatus;
const html = (status: StorageStatus | null) => renderToStaticMarkup(createElement(StorageBanner, { status }));

test('nothing is shown while the pool is ok, unknown or not yet loaded', () => {
  assert.equal(storageBanner(at('ok', 79.9)), null);
  assert.equal(storageBanner({ state: 'unavailable' }), null);
  assert.equal(html(at('ok', 79.9)), '');
  assert.equal(html({ state: 'unavailable' }), '');
  assert.equal(html(null), '');
});

test('warning is amber and names the used share of the pool', () => {
  const view = storageBanner(at('warning', 82.4))!;
  assert.equal(view.tone, 'warning');
  assert.equal(view.title, 'พื้นที่เก็บงานใช้ไปแล้ว 82%');
  assert.match(view.detail, /ลบไฟล์หรืองานที่ไม่ใช้/);
  const markup = html(at('warning', 80));
  assert.match(markup, /class="storage-banner warning"/);
  assert.match(markup, /role="status"/);
  assert.match(markup, /ใช้ไปแล้ว 80%/);
});

test('critical is red and urgent', () => {
  const view = storageBanner(at('critical', 95))!;
  assert.equal(view.tone, 'critical');
  assert.equal(view.title, 'พื้นที่เก็บงานเกือบเต็มแล้ว (95%)');
  const markup = html(at('critical', 97.3));
  assert.match(markup, /class="storage-banner critical"/);
  assert.match(markup, /role="alert"/);
  assert.match(markup, /เกือบเต็มแล้ว \(97%\)/);
});

test('full explains that new saves and uploads fail while existing files stay readable and deletable', () => {
  const view = storageBanner(at('full', 100))!;
  assert.equal(view.tone, 'full');
  assert.equal(view.title, 'พื้นที่เก็บงานเต็มแล้ว');
  assert.match(view.detail, /บันทึกงานใหม่และอัปโหลดไฟล์ไม่ได้/);
  assert.match(view.detail, /งานเดิมยังอยู่ครบ/);
  assert.match(view.detail, /เปิดอ่าน ดาวน์โหลด และลบได้ตามปกติ/);
  assert.match(html(at('full', 100)), /class="storage-banner full"[^>]*role="alert"/);
});

test('the file count is named when it is the worse of the two limits', () => {
  assert.equal(storageBanner(at('warning', 12, 85.5))!.title, 'จำนวนไฟล์ใช้ไปแล้ว 85% ของที่ให้ไว้');
  assert.equal(storageBanner(at('critical', 3, 96))!.title, 'จำนวนไฟล์เกือบเต็มแล้ว (96%)');
  assert.equal(storageBanner(at('full', 40, 100))!.title, 'จำนวนไฟล์เต็มแล้ว');
  // Bytes still named when they are worse, even with many files.
  assert.equal(storageBanner(at('warning', 90, 85))!.title, 'พื้นที่เก็บงานใช้ไปแล้ว 90%');
});

test('a refused save shows its own Thai message without a misleading documents action', () => {
  const view = errorView('STORAGE_FULL');
  assert.equal(view.title, 'พื้นที่เก็บงานเต็มแล้ว');
  assert.match(view.detail, /งานเดิมยังอยู่ครบ/);
  assert.equal(view.retry, false);
});

test('the refusal notice offers no action button (the documents page is not in Cloud Workspace)', () => {
  assert.equal(noticeHasAction('STORAGE_FULL'), false);
  // The existing Supabase file quota still offers its documents action.
  assert.equal(noticeHasAction('STORAGE_QUOTA'), true);
});
