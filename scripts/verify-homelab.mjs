import assert from 'node:assert/strict';

const origin = new URL(process.argv[2] || 'http://127.0.0.1:8080');
assert.ok(['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password);
async function get(path, status = 200) {
  const response = await fetch(new URL(path, origin), {
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  assert.equal(response.status, status, `${path}: unexpected HTTP status`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
  assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
  assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/, path);
  return response;
}
assert.equal(await (await get('/healthz')).text(), 'ok\n');
const home = await get('/');
assert.match(home.headers.get('cache-control') || '', /no-cache/);
const html = await home.text();
assert.equal(await (await get('/auth/callback')).text(), html);
const worker = await get('/sw.js');
assert.match(worker.headers.get('cache-control') || '', /no-cache/);
assert.match(await worker.text(), /authorization/);
const script = html.match(/src="(\/assets\/[^"<>]+\.js)"/)?.[1];
assert.ok(script, 'HTML must reference a built JavaScript bundle');
const asset = await get(script);
assert.match(asset.headers.get('content-type') || '', /javascript/);
assert.match(asset.headers.get('cache-control') || '', /immutable/);
await get('/assets/missing-bundle.js', 404);
await get('/.env', 404);
await get('/_headers', 404);
console.log('Passed: static shell, OAuth callback, PWA cache headers, CSP and missing-asset checks.');
console.log(
  'This checks frontend hosting only; Google login, tenant access and AI require separate acceptance.',
);
