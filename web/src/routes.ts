export const pagePaths = {
  chat: '/',
  skills: '/skills',
  documents: '/documents',
  memory: '/memory',
  receipt: '/receipt',
  settings: '/settings',
} as const;
export type Page = keyof typeof pagePaths;

// Return destinations are application pages, never arbitrary URLs or OAuth callbacks.
export function returnPath(value: string | null) {
  return Object.values(pagePaths).some((path) => path === value) ? value! : '/';
}
export function routePage(pathname: string): Page {
  return (Object.entries(pagePaths).find(([, path]) => path === pathname)?.[0] as Page) || 'chat';
}
export function loginPath(pathname: string) {
  const next = returnPath(pathname);
  return next === '/' ? '/login' : '/login?next=' + encodeURIComponent(next);
}
export function navigate(path: string, replace = false) {
  if (location.pathname + location.search === path) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
export function subscribeRoute(listener: () => void) {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}
export function currentRoute() {
  return location.pathname + location.search;
}
export const returnPathKey = 'step-auth-return-path';
