import { test, expect, type Page } from '@playwright/test';
import type { Memory, Snapshot } from '../../packages/harness-core/src/contracts.ts';

type AuditState = {
  reads: number;
  starts: number;
  saves: Record<string, unknown>[];
  errors: string[];
  memories: Memory[];
  complete?: () => void;
};
type AuditWindow = typeof window & { auditRegression: AuditState };

/** Mount production components with synthetic hosts, without adding app test hooks. */
async function mountAudit(
  page: Page,
  view: 'receipt' | 'memory',
  firstError: 'NETWORK_ERROR' | 'ACCESS_DENIED' = 'NETWORK_ERROR',
) {
  const external: string[] = [],
    pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      external.push(url.href);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto('/?demo=1');
  await expect(page.getByRole('heading', { name: /ให้ AI ร่างงานหนัก/ })).toBeVisible();
  const modules = await page.evaluate(() => {
    const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
    return {
      reactUrl: resources.find((url) => url.includes('/react.js?')),
      domUrl: resources.find((url) => url.includes('/react-dom_client.js?')),
    };
  });
  await page.clock.install({ time: new Date('2026-10-24T12:00:00.123Z') });
  await page.evaluate(
    async ({ view, firstError, reactUrl, domUrl }) => {
      // Reuse Vite's exact URLs, including their version queries, to avoid a second React instance.
      if (!reactUrl || !domUrl) throw new Error('Vite React modules were not loaded');
      const load = (url: string) => import(/* @vite-ignore */ url);
      const [{ default: React }, { default: ReactDOM }, { demoHost }, { ApiError }, { ErrorNotice }] =
        await Promise.all([
          load(reactUrl),
          load(domUrl),
          load('/src/demo.ts'),
          load('/src/host.ts'),
          load('/src/components.tsx'),
        ]);
      const { ReceiptView } = await load('/src/ReceiptView.tsx');
      const { Memories } = await load('/src/Memories.tsx');
      const base = demoHost();
      const data = (await base.call('snapshot')) as Snapshot;
      const tenant = data.tenants[0].id;
      data.memories = [
        {
          ...data.memories[0],
          id: crypto.randomUUID(),
          title: 'expired-synthetic',
          expires_at: '2026-10-23T03:04:05.678Z',
        },
        {
          ...data.memories[0],
          id: crypto.randomUUID(),
          title: 'subday-synthetic',
          expires_at: '2026-10-24T14:04:05.678Z',
        },
      ];
      data.documents = [
        {
          id: crypto.randomUUID(),
          tenant_id: tenant,
          owner_id: data.user.id,
          workspace_id: null,
          visibility: 'private',
          name: 'synthetic-receipt.pdf',
          mime: 'application/pdf',
          bytes: 100,
          source_kind: 'upload',
          drive_file_id: null,
          object_path: null,
          status: 'ready',
          error_code: null,
          created_at: new Date().toISOString(),
        },
      ];
      const state: AuditState = {
        reads: 0,
        starts: 0,
        saves: [],
        errors: [],
        memories: data.memories,
      };
      (window as AuditWindow).auditRegression = state;
      const run = {
        id: crypto.randomUUID(),
        document_id: data.documents[0].id,
        status: 'running',
      };
      const host = {
        ...base,
        async call(action: string, payload: Record<string, unknown> = {}) {
          if (action === 'receipt.history') return [];
          if (action === 'run.start') {
            state.starts++;
            return run;
          }
          if (action === 'run.read') {
            state.reads++;
            if (state.reads === 1 || firstError === 'ACCESS_DENIED') throw new ApiError(firstError);
            return new Promise((resolve) => {
              state.complete = () =>
                resolve({
                  ...run,
                  status: 'completed',
                  result: {
                    receipt: {
                      document_type: 'general_receipt',
                      complete: 'uncertain',
                      signature: 'uncertain',
                      checks: [],
                      next_steps: ['Synthetic result: compare with the original'],
                      warnings: [],
                    },
                  },
                });
            });
          }
          if (action === 'memory.save') {
            state.saves.push(structuredClone(payload));
            const memory = data.memories.find((m) => m.id === payload.id);
            if (!memory) throw new Error('Unexpected synthetic memory');
            memory.body = String(payload.body);
            if (Object.hasOwn(payload, 'ttlDays'))
              memory.expires_at = payload.ttlDays
                ? new Date(Date.now() + Number(payload.ttlDays) * 86_400_000).toISOString()
                : null;
            return { ...memory };
          }
          throw new Error('Unexpected synthetic action: ' + action);
        },
      };
      function Harness() {
        const [snapshot, setSnapshot] = React.useState(data);
        const [error, setError] = React.useState(null);
        return React.createElement(
          'main',
          null,
          React.createElement(view === 'receipt' ? ReceiptView : Memories, {
            host,
            data: snapshot,
            tenant,
            workspace: null,
            refresh: async () => setSnapshot(structuredClone(data)),
            fail: (error: Error) => {
              state.errors.push(error.message);
              setError(error);
            },
          }),
          error &&
            React.createElement(ErrorNotice, {
              error,
              onDismiss: () => setError(null),
              onAction: () => setError(null),
            }),
        );
      }
      const node = document.createElement('div');
      document.body.replaceChildren(node);
      ReactDOM.createRoot(node).render(React.createElement(Harness));
    },
    { view, firstError, ...modules },
  );
  return () => {
    expect(external).toEqual([]);
    expect(pageErrors).toEqual([]);
  };
}

async function startReceipt(page: Page) {
  await page.getByRole('combobox', { name: 'เลือกใบเสร็จที่เก็บไว้' }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'เริ่มตรวจใบเสร็จ', exact: true }).click();
  await page.getByRole('button', { name: 'ยืนยันและเริ่มตรวจ', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as AuditWindow).auditRegression.reads)).toBe(1);
}

test('receipt status polling recovers from a network failure without starting OCR twice', async ({
  page,
}) => {
  const verifyLocal = await mountAudit(page, 'receipt');
  await startReceipt(page);
  await expect(page.getByRole('combobox', { name: 'เลือกใบเสร็จที่เก็บไว้' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'เริ่มตรวจใบเสร็จ', exact: true })).toHaveCount(0);
  await page.clock.fastForward(15_000);
  await expect.poll(() => page.evaluate(() => (window as AuditWindow).auditRegression.reads)).toBe(2);
  await expect(page.getByRole('combobox', { name: 'เลือกใบเสร็จที่เก็บไว้' })).toBeDisabled();
  await page.evaluate(() => (window as AuditWindow).auditRegression.complete!());
  await expect(page.getByRole('heading', { name: 'ใบเสร็จประเภทไหน' })).toBeVisible();
  await page.clock.fastForward(15_000);
  expect(
    await page.evaluate(() => {
      const { starts, reads } = (window as AuditWindow).auditRegression;
      return { starts, reads };
    }),
  ).toEqual({ starts: 1, reads: 2 });
  verifyLocal();
});

test('receipt polling stops on access denial and provides the access recovery action', async ({ page }) => {
  const verifyLocal = await mountAudit(page, 'receipt', 'ACCESS_DENIED');
  await startReceipt(page);
  const error = page.getByRole('alert');
  await expect(error).toContainText('คุณยังเข้าถึงข้อมูลนี้ไม่ได้');
  await expect(error.getByRole('button', { name: 'กลับไปหน้าหลัก', exact: true })).toBeVisible();
  await page.clock.fastForward(30_000);
  expect(
    await page.evaluate(() => {
      const { starts, reads } = (window as AuditWindow).auditRegression;
      return { starts, reads };
    }),
  ).toEqual({ starts: 1, reads: 1 });
  verifyLocal();
});

test('editing expired and partly elapsed memories preserves their exact expiry by default', async ({
  page,
}) => {
  const verifyLocal = await mountAudit(page, 'memory');
  for (const title of ['expired-synthetic', 'subday-synthetic']) {
    const before = await page.evaluate(
      (title) => (window as AuditWindow).auditRegression.memories.find((m) => m.title === title)!.expires_at,
      title,
    );
    await page.getByRole('button', { name: 'แก้ไข ' + title, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('checkbox', { name: 'เปลี่ยนอายุความจำ' })).not.toBeChecked();
    await expect(dialog.getByRole('spinbutton', { name: /อายุความจำ/ })).toHaveCount(0);
    await dialog
      .getByRole('textbox', { name: 'สิ่งที่ต้องการจำ', exact: true })
      .fill('Synthetic edited body');
    await dialog.getByRole('button', { name: 'ยืนยันและบันทึก', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = await page.evaluate((title) => {
      const state = (window as AuditWindow).auditRegression;
      return {
        expires_at: state.memories.find((m) => m.title === title)!.expires_at,
        payload: state.saves.at(-1),
      };
    }, title);
    expect(saved.expires_at).toBe(before);
    expect(saved.payload).not.toHaveProperty('ttlDays');
    expect(saved.payload).toHaveProperty('body', 'Synthetic edited body');
  }
  verifyLocal();
});

test('memory lifetime changes require opt-in and support renewal or deliberate permanent retention', async ({
  page,
}) => {
  const verifyLocal = await mountAudit(page, 'memory');
  const edit = page.getByRole('button', { name: 'แก้ไข expired-synthetic', exact: true });
  await edit.click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: 'เปลี่ยนอายุความจำ' }).check();
  await dialog.getByRole('spinbutton', { name: /อายุความจำ/ }).fill('2');
  await dialog.getByRole('button', { name: 'ยืนยันและบันทึก', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const renewed = await page.evaluate(() => {
    const state = (window as AuditWindow).auditRegression;
    return { payload: state.saves.at(-1), remaining: Date.parse(state.memories[0].expires_at!) - Date.now() };
  });
  expect(renewed.payload).toHaveProperty('ttlDays', 2);
  expect(renewed.remaining).toBeGreaterThan(2 * 86_400_000 - 10_000);
  expect(renewed.remaining).toBeLessThanOrEqual(2 * 86_400_000);
  await edit.click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('checkbox', { name: 'เปลี่ยนอายุความจำ' })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: 'เปลี่ยนอายุความจำ' }).check();
  await dialog.getByRole('spinbutton', { name: /อายุความจำ/ }).fill('0');
  await dialog.getByRole('button', { name: 'ยืนยันและบันทึก', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const permanent = await page.evaluate(() => {
    const state = (window as AuditWindow).auditRegression;
    return { payload: state.saves.at(-1), expires_at: state.memories[0].expires_at };
  });
  expect(permanent.payload).toHaveProperty('ttlDays', 0);
  expect(permanent.expires_at).toBeNull();
  verifyLocal();
});
