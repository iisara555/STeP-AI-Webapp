import { test, expect, type Page } from '@playwright/test';
import type { Conversation, Snapshot } from '../../packages/harness-core/src/contracts.ts';

type SaveInput = { tenant: string; id: string; version: number; draft: string };
type DraftHarness = {
  writes: SaveInput[];
  errors: string[];
  sessionId: string | null;
  cache: () => { text: string; savedText: string; hasUnsaved: boolean };
  resolveSave: (index: number) => void;
  resolveRead?: () => void;
  select: (task: 'A' | 'B') => void;
  show: (visible: boolean) => void;
};
type HarnessWindow = typeof window & { draftAsyncRegression: DraftHarness };

/** The parent subscribes to the real DraftBook exactly as App does; all persistence is synthetic. */
async function mountDrafts(page: Page, initialRead: 'normal' | 'delayed' | 'denied' = 'normal') {
  const external: string[] = [],
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
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
  await page.evaluate(async (initialRead) => {
    const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
    const reactUrl = resources.find((url) => url.includes('/react.js?'));
    const domUrl = resources.find((url) => url.includes('/react-dom_client.js?'));
    if (!reactUrl || !domUrl) throw new Error('Vite React modules were not loaded');
    const load = (url: string) => import(/* @vite-ignore */ url);
    const [{ default: React }, { default: ReactDOM }, { Chat }, { DraftBook }, { demoHost }, { ApiError }] =
      await Promise.all([
        load(reactUrl),
        load(domUrl),
        load('/src/Chat.tsx'),
        load('/src/drafts.ts'),
        load('/src/demo.ts'),
        load('/src/host.ts'),
      ]);
    const data = (await demoHost().call('snapshot')) as Snapshot;
    const tenant = data.tenants[0].id;
    const a: Conversation = {
      id: crypto.randomUUID(),
      tenant_id: tenant,
      owner_id: data.user.id,
      workspace_id: null,
      visibility: 'private',
      title: 'SYNTHETIC TASK A',
      draft: 'Saved draft A',
      version: 1,
    };
    const b: Conversation = {
      ...a,
      id: crypto.randomUUID(),
      title: 'SYNTHETIC TASK B',
      draft: 'Saved draft B',
    };
    const records: Record<string, Conversation> = { [a.id]: a, [b.id]: b };
    const pending: (() => void)[] = [];
    let reads = 0;
    const state: DraftHarness = {
      writes: [],
      errors: [],
      sessionId: a.id,
      cache: () => ({ text: '', savedText: '', hasUnsaved: false }),
      resolveSave: (index) => pending[index](),
      select: () => {},
      show: () => {},
    };
    (window as HarnessWindow).draftAsyncRegression = state;
    const host = {
      demo: true,
      async call(action: string, input: SaveInput) {
        if (action === 'session.read') {
          const first = reads++ === 0;
          if (initialRead === 'denied' && first) throw new ApiError('ACCESS_DENIED');
          const response = {
            session: structuredClone(records[input.id]),
            messages: [
              {
                id: crypto.randomUUID(),
                role: 'assistant',
                body: 'Synthetic session read completed',
                sources: [],
                created_at: new Date().toISOString(),
              },
            ],
            runs: [],
          };
          if (initialRead === 'delayed' && first)
            return new Promise((resolve) => {
              state.resolveRead = () => resolve(response);
            });
          return response;
        }
        if (action === 'session.draft') {
          state.writes.push(structuredClone(input));
          return new Promise((resolve) => {
            pending.push(() => {
              const saved = {
                ...records[input.id],
                draft: input.draft,
                version: input.version + 1,
              };
              records[input.id] = saved;
              resolve(saved);
            });
          });
        }
        throw new Error('Unexpected synthetic action: ' + action);
      },
    };
    const drafts = new DraftBook(tenant);
    if (initialRead === 'denied') drafts.edit(a, 'Dirty cached draft before access revocation');
    state.cache = () => ({ ...drafts.get(a), hasUnsaved: drafts.hasUnsaved() });
    const node = document.createElement('div');
    const artifactSlot = document.createElement('div');
    artifactSlot.className = 'artifact-slot';
    document.body.replaceChildren(node, artifactSlot);
    function Harness() {
      const [session, setSession] = React.useState(a);
      const [visible, setVisible] = React.useState(true);
      React.useSyncExternalStore(drafts.subscribe, drafts.revision);
      state.sessionId = session?.id || null;
      state.select = (task) => setSession(records[task === 'A' ? a.id : b.id]);
      state.show = setVisible;
      return visible
        ? React.createElement(Chat, {
            host,
            data,
            tenant,
            workspace: null,
            refresh: async () => {},
            fail: (error: Error) => state.errors.push(error.message),
            session,
            setSession,
            skill: null,
            clearSkill: () => {},
            newSession: () => {},
            prepared: null,
            consumePrepared: () => {},
            onPrepare: async () => {},
            artifactSlot,
            drafts,
          })
        : React.createElement('p', null, 'Synthetic tool page');
    }
    ReactDOM.createRoot(node).render(React.createElement(Harness));
  }, initialRead);
  return async (expectedErrors: string[] = []) => {
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => (window as HarnessWindow).draftAsyncRegression.errors)).toEqual(
      expectedErrors,
    );
  };
}

async function editor(page: Page) {
  const field = page.getByRole('textbox', { name: 'ร่างเอกสาร', exact: true });
  if (!(await field.isVisible())) await page.getByRole('button', { name: 'เปิดร่าง', exact: true }).click();
  return field;
}

async function select(page: Page, task: 'A' | 'B') {
  await page.evaluate((task) => (window as HarnessWindow).draftAsyncRegression.select(task), task);
  await expect(page.locator('.topbar-heading strong')).toHaveText('SYNTHETIC TASK ' + task);
}

test('late saves keep the active task and its edits across switching and Chat remounting', async ({
  page,
}) => {
  const verifyLocal = await mountDrafts(page);
  await (await editor(page)).fill('Draft A first save');
  await page.getByRole('button', { name: 'บันทึก', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as HarnessWindow).draftAsyncRegression.writes.length))
    .toBe(1);
  await select(page, 'B');
  await (await editor(page)).fill('Unsaved draft B');
  await page.getByRole('textbox', { name: 'ข้อความถึง AI', exact: true }).fill('Unsent request B');
  await page.evaluate(() => (window as HarnessWindow).draftAsyncRegression.resolveSave(0));
  await expect(page.locator('.topbar-heading strong')).toHaveText('SYNTHETIC TASK B');
  await expect(await editor(page)).toHaveValue('Unsaved draft B');
  await expect(page.getByRole('textbox', { name: 'ข้อความถึง AI', exact: true })).toHaveValue(
    'Unsent request B',
  );

  await select(page, 'A');
  await (await editor(page)).fill('Draft A second save');
  await page.getByRole('button', { name: 'บันทึก', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as HarnessWindow).draftAsyncRegression.writes.length))
    .toBe(2);
  await page.evaluate(() => (window as HarnessWindow).draftAsyncRegression.show(false));
  await expect(page.getByText('Synthetic tool page', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = (window as HarnessWindow).draftAsyncRegression;
    state.select('B');
    state.show(true);
  });
  await expect(page.locator('.topbar-heading strong')).toHaveText('SYNTHETIC TASK B');
  await expect(await editor(page)).toHaveValue('Unsaved draft B');
  await page
    .getByRole('textbox', { name: 'ข้อความถึง AI', exact: true })
    .fill('Unsent request after remount');
  await page.evaluate(() => (window as HarnessWindow).draftAsyncRegression.resolveSave(1));
  await expect(page.locator('.topbar-heading strong')).toHaveText('SYNTHETIC TASK B');
  await expect(await editor(page)).toHaveValue('Unsaved draft B');
  await expect(page.getByRole('textbox', { name: 'ข้อความถึง AI', exact: true })).toHaveValue(
    'Unsent request after remount',
  );
  await verifyLocal();
});

test('editing during a pending save preserves newer text and the next save uses the acknowledged version', async ({
  page,
}) => {
  const verifyLocal = await mountDrafts(page);
  await (await editor(page)).fill('Text sent in first save');
  await page.getByRole('button', { name: 'บันทึก', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as HarnessWindow).draftAsyncRegression.writes.length))
    .toBe(1);
  await (await editor(page)).fill('Newer unsaved text');
  await page.evaluate(() => (window as HarnessWindow).draftAsyncRegression.resolveSave(0));
  await expect(await editor(page)).toHaveValue('Newer unsaved text');
  await expect(page.getByText('ร่าง Markdown · ยังไม่บันทึก', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'บันทึก', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as HarnessWindow).draftAsyncRegression.writes.length))
    .toBe(2);
  const writes = await page.evaluate(() => (window as HarnessWindow).draftAsyncRegression.writes);
  expect(writes.map(({ version, draft }) => ({ version, draft }))).toEqual([
    { version: 1, draft: 'Text sent in first save' },
    { version: 2, draft: 'Newer unsaved text' },
  ]);
  await page.evaluate(() => (window as HarnessWindow).draftAsyncRegression.resolveSave(1));
  await expect(page.getByText('ร่าง Markdown · บันทึกแล้ว', { exact: true })).toBeVisible();
  await expect(await editor(page)).toHaveValue('Newer unsaved text');
  await verifyLocal();
});

test('a delayed initial session read cannot overwrite a draft already being typed', async ({ page }) => {
  const verifyLocal = await mountDrafts(page, 'delayed');
  await (await editor(page)).fill('Typed before session read returned');
  await page.evaluate(() => (window as HarnessWindow).draftAsyncRegression.resolveRead!());
  await expect(page.getByText('Synthetic session read completed', { exact: true })).toBeVisible();
  await expect(await editor(page)).toHaveValue('Typed before session read returned');
  await expect(page.getByText('ร่าง Markdown · ยังไม่บันทึก', { exact: true })).toBeVisible();
  await verifyLocal();
});

test('an authoritative access denial clears the active draft without waiting for a recovery click', async ({
  page,
}) => {
  const verifyLocal = await mountDrafts(page, 'denied');
  await expect
    .poll(() => page.evaluate(() => (window as HarnessWindow).draftAsyncRegression.sessionId))
    .toBeNull();
  const cache = await page.evaluate(() => (window as HarnessWindow).draftAsyncRegression.cache());
  expect(cache.hasUnsaved).toBe(false);
  expect(cache.text).toBe('Saved draft A');
  await expect(page.getByRole('textbox', { name: 'ร่างเอกสาร', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ส่งออก', exact: true })).toHaveCount(0);
  await verifyLocal(['ACCESS_DENIED']);
});
