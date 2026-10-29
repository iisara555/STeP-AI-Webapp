import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { demoHost } from '../../web/src/demo.ts';
import type { Snapshot } from '../../packages/harness-core/src/contracts.ts';

test.use({ baseURL: 'http://127.0.0.1:5174' });
const origin = 'http://127.0.0.1:5174';
const storageKey = 'step-auth-auth.example.test';
// The sidebar's tool navigation exists only inside the signed-in workspace. Count DOM nodes, not
// visibility, because the mobile sidebar stays closed until opened.
const workspaceNav = (page: Page) => page.locator('nav[aria-label="เครื่องมือ"]');

async function authFixture(
  context: BrowserContext,
  options: { signedIn?: boolean; invited?: boolean; switchToInvited?: boolean } = {},
) {
  const host = demoHost();
  const snapshot = await host.call<Snapshot>('snapshot');
  let user = {
    id: options.switchToInvited ? 'previous-account' : snapshot.user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'employee@example.test',
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: {},
    identities: [{ id: 'synthetic-google-identity', provider: 'google', user_id: snapshot.user.id }],
    created_at: '2026-01-01T00:00:00Z',
  };
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const makeSession = (identity: typeof user) => {
    const token =
      [
        { alg: 'HS256', typ: 'JWT' },
        { sub: identity.id, exp: expires, aud: 'authenticated', role: 'authenticated' },
      ]
        .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
        .join('.') + '.synthetic';
    return {
      access_token: token,
      refresh_token: 'synthetic-refresh-test-only',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: expires,
      user: identity,
    };
  };
  let session = makeSession(user);
  let invited = options.invited !== false;
  const state = {
    userStatus: 200,
    tokenStatus: 200,
    snapshotStatus: 200,
    snapshots: 0,
    exchanges: 0,
    redirect: '',
    prompt: '',
    cancelAuthorization: false,
    logouts: 0,
    events: [] as string[],
  };
  if (options.signedIn)
    await context.addInitScript(
      ({ storageKey, session, origin }) => {
        if (location.origin === origin && !sessionStorage.getItem('seeded')) {
          localStorage.setItem(storageKey, JSON.stringify(session));
          sessionStorage.setItem('seeded', '1');
        }
      },
      { storageKey, session, origin },
    );
  await context.route('https://auth.example.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/auth/v1/authorize') {
      state.redirect = url.searchParams.get('redirect_to') || '';
      state.prompt = url.searchParams.get('prompt') || '';
      state.events.push('authorize');
      if (options.switchToInvited) {
        user = { ...user, id: snapshot.user.id, email: 'invited@example.test' };
        session = makeSession(user);
        invited = true;
      }
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      await route.fulfill({
        status: 302,
        headers: {
          location:
            origin +
            (state.cancelAuthorization
              ? '/auth/callback?error=access_denied'
              : '/auth/callback?code=synthetic-code'),
        },
      });
    } else if (url.pathname === '/auth/v1/token') {
      state.exchanges++;
      await route.fulfill({
        status: state.tokenStatus,
        json:
          state.tokenStatus === 200
            ? session
            : { error: 'invalid_grant', error_description: 'Synthetic expired code' },
      });
    } else if (url.pathname === '/auth/v1/user') {
      await route.fulfill({
        status: state.userStatus,
        json: state.userStatus === 200 ? user : { code: 'bad_jwt', message: 'Synthetic rejected token' },
      });
    } else if (url.pathname === '/auth/v1/logout') {
      state.logouts++;
      state.events.push('logout');
      await route.fulfill({ status: 204 });
    } else if (url.pathname === '/functions/v1/api') {
      const { action, input } = route.request().postDataJSON();
      if (action === 'snapshot') {
        state.snapshots++;
        await route.fulfill({
          status: state.snapshotStatus,
          json:
            state.snapshotStatus === 200
              ? { data: { ...snapshot, tenants: invited ? snapshot.tenants : [] } }
              : { code: 'UNAUTHENTICATED' },
        });
      } else await route.fulfill({ json: { data: await host.call(action, input) } });
    } else throw new Error('Unexpected synthetic Auth request: ' + url.pathname);
  });
  return state;
}

test('every protected URL sends anonymous visitors to login without requesting workspace data', async ({
  page,
  context,
}) => {
  const state = await authFixture(context);
  for (const path of [
    '/',
    '/skills',
    '/documents',
    '/memory',
    '/receipt',
    '/settings',
    '/document-tools',
    '/media',
    '/history',
    '/help',
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(
      new RegExp('/login' + (path === '/' ? '$' : '\\?next=' + encodeURIComponent(path) + '$')),
    );
    await expect(page.getByRole('button', { name: 'ลงชื่อเข้าใช้ด้วย Google' })).toBeVisible();
    await expect(workspaceNav(page)).toHaveCount(0);
  }
  expect(state.snapshots).toBe(0);
});

test('Google PKCE login returns to the requested page and exchanges the callback only once', async ({
  page,
  context,
}) => {
  const state = await authFixture(context);
  await page.goto('/documents');
  await page.getByRole('button', { name: 'ลงชื่อเข้าใช้ด้วย Google' }).click();
  await expect(page).toHaveURL(origin + '/documents');
  await expect(page.getByRole('heading', { name: 'เอกสาร', exact: true })).toBeVisible();
  expect(state.redirect).toBe(origin + '/auth/callback');
  expect(state.prompt).toBe('select_account');
  expect(state.exchanges).toBe(1);
  await expect(workspaceNav(page).first()).toBeAttached();
  const open = page.getByRole('button', { name: 'เปิดเมนู', exact: true });
  if (await open.isVisible()) await open.click();
  await workspaceNav(page)
    .getByRole('button', { name: /^ศูนย์รวม Skill/ })
    .click();
  await expect(page).toHaveURL(origin + '/skills');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'เอกสาร', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'เอกสาร', exact: true })).toBeVisible();
});

test('forged cached identity is rejected before any private data request', async ({ page, context }) => {
  const state = await authFixture(context, { signedIn: true });
  state.userStatus = 401;
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
  await expect(workspaceNav(page)).toHaveCount(0);
  expect(state.snapshots).toBe(0);
});

test('API session rejection returns to login and removes private views', async ({ page, context }) => {
  const state = await authFixture(context, { signedIn: true });
  state.snapshotStatus = 401;
  await page.goto('/memory');
  await expect(page).toHaveURL(/\/login\?next=%2Fmemory$/);
  await expect(workspaceNav(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'บัญชีนี้ยังไม่ได้รับเชิญ' })).toHaveCount(0);
});

test('verified accounts still need a tenant invitation', async ({ page, context }) => {
  await authFixture(context, { signedIn: true, invited: false });
  await page.goto('/documents');
  await expect(page.getByRole('heading', { name: 'บัญชีนี้ยังไม่ได้รับเชิญ' })).toBeVisible();
  await expect(workspaceNav(page)).toHaveCount(0);
});

test('an uninvited user can switch Google accounts directly', async ({ page, context }) => {
  const state = await authFixture(context, { signedIn: true, invited: false, switchToInvited: true });
  await page.goto('/documents');
  await expect(page.getByRole('heading', { name: 'บัญชีนี้ยังไม่ได้รับเชิญ' })).toBeVisible();
  await page.getByRole('button', { name: 'เปลี่ยนบัญชี' }).click();
  await expect.poll(() => state.exchanges).toBe(1);
  expect(state.logouts).toBe(1);
  expect(state.prompt).toBe('select_account');
  expect(state.events).toEqual(['logout', 'authorize']);
  await expect(workspaceNav(page).first()).toBeAttached();
  await expect(page.getByRole('heading', { name: 'บัญชีนี้ยังไม่ได้รับเชิญ' })).toHaveCount(0);
});

test('cancelling Google account selection returns to login without old private data', async ({
  page,
  context,
}) => {
  const state = await authFixture(context, { signedIn: true, invited: false });
  state.cancelAuthorization = true;
  await page.goto('/documents');
  await expect(page.getByRole('heading', { name: 'บัญชีนี้ยังไม่ได้รับเชิญ' })).toBeVisible();
  await page.getByRole('button', { name: 'เปลี่ยนบัญชี' }).click();
  await expect(page).toHaveURL(origin + '/login');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(workspaceNav(page)).toHaveCount(0);
  expect(state.events).toEqual(['logout', 'authorize']);
  expect(state.exchanges).toBe(0);
});

test('signing out clears both tabs and browser history cannot reopen private views', async ({
  page,
  context,
}) => {
  await authFixture(context, { signedIn: true });
  await page.goto('/documents');
  await expect(page.getByRole('heading', { name: 'เอกสาร', exact: true })).toBeVisible();
  const second = await context.newPage();
  await second.goto(origin + '/memory');
  await expect(second.getByRole('heading', { name: 'ความจำ', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'เมนู STeP', exact: true }).click();
  await page.getByRole('menuitem', { name: 'ออกจากระบบ', exact: true }).click();
  await expect(page).toHaveURL(origin + '/login');
  await expect(second).toHaveURL(/\/login\?next=%2Fmemory$/);
  await page.goto('/documents');
  await expect(workspaceNav(page)).toHaveCount(0);
});

test('OAuth errors and missing codes are sanitized and leave protected views closed', async ({
  page,
  context,
}) => {
  const state = await authFixture(context);
  for (const query of ['', '?error=access_denied&error_description=private-provider-details']) {
    await page.goto('/auth/callback' + query);
    await expect(page).toHaveURL(origin + '/login');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText('private-provider-details')).toHaveCount(0);
  }
  expect(state.exchanges).toBe(0);
  expect(state.snapshots).toBe(0);
});

test('an expired PKCE code fails once and leaves the visitor on login', async ({ page, context }) => {
  const state = await authFixture(context);
  state.tokenStatus = 400;
  await page.goto('/login?next=%2Fsettings');
  await page.getByRole('button', { name: 'ลงชื่อเข้าใช้ด้วย Google' }).click();
  await expect(page).toHaveURL(origin + '/login');
  await expect(page.getByRole('alert')).toBeVisible();
  expect(state.exchanges).toBe(1);
  expect(state.snapshots).toBe(0);
});
