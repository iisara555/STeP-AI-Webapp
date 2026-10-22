import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
test('PWA only intercepts public shell assets; authenticated or external data bypasses its cache', async () => {
  const events = new Map<string, (event: any) => void>();
  const source = (await readFile('web/sw-template.js', 'utf8'))
    .replace('__APP_SHELL__', JSON.stringify(['/', '/index.html', '/assets/app.js']))
    .replace('__CACHE_VERSION__', 'synthetic');
  runInNewContext(source, {
    self: {
      location: { origin: 'https://app.example.test' },
      addEventListener: (name: string, handler: (e: any) => void) => events.set(name, handler),
    },
    URL,
    caches: { match: async () => new Response('shell') },
    fetch: async () => new Response('network'),
  });
  for (const request of [
    new Request('https://app.example.test/assets/app.js', { headers: { Authorization: 'Bearer synthetic' } }),
    new Request('https://app.example.test/private/document.pdf'),
    new Request('https://server.example.test/rest/v1/memories'),
    new Request('https://app.example.test/assets/app.js?private=1'),
    new Request('https://app.example.test/api', { method: 'POST' }),
  ]) {
    let intercepted = false;
    events.get('fetch')!({
      request,
      respondWith: () => {
        intercepted = true;
      },
    });
    assert.equal(intercepted, false, request.url);
  }
  let response: Promise<Response> | undefined;
  events.get('fetch')!({
    request: new Request('https://app.example.test/assets/app.js'),
    respondWith: (r: Promise<Response>) => {
      response = r;
    },
  });
  assert.equal(await (await response!).text(), 'shell');
});
test('application has install icons and never precaches API URLs', async () => {
  const manifest = JSON.parse(await readFile('web/public/manifest.webmanifest', 'utf8'));
  for (const size of ['192x192', '512x512'])
    assert.ok(manifest.icons.some((i: { sizes: string }) => i.sizes === size));
  const sw = await readFile('web/sw-template.js', 'utf8');
  assert.ok(sw.includes("event.request.headers.has('authorization')"));
});
