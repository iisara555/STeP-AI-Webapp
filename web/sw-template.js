/* Cache public application files only. Auth, API responses, Google data and
   document downloads are never handled by this service worker. */
const SHELL = __APP_SHELL__;
const CACHE = 'step-shell-__CACHE_VERSION__';
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('step-shell-') && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
});
self.addEventListener('message', (event) => {
  if (event.data === 'activate-update') self.skipWaiting();
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    event.request.headers.has('authorization')
  )
    return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/index.html')));
    return;
  }
  if (!SHELL.includes(url.pathname) || url.search) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
