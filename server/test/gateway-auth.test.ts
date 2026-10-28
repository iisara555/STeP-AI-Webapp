import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { googleIdTokenAuth } from '../src/gateway/auth.ts';

// A synthetic signing key stands in for Google's; no request leaves the machine.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'synthetic-key';
const NOW = Date.UTC(2026, 9, 28, 9, 0, 0);
const CLIENT = 'synthetic-client.apps.googleusercontent.com';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(
  claims: Record<string, unknown>,
  options: { kid?: string; alg?: string; key?: typeof privateKey } = {},
) {
  const head = b64({ alg: options.alg ?? 'RS256', kid: options.kid ?? KID, typ: 'JWT' });
  const body = b64(claims);
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), options.key ?? privateKey).toString(
    'base64url',
  );
  return `Bearer ${head}.${body}.${signature}`;
}
const valid = {
  iss: 'https://accounts.google.com',
  aud: CLIENT,
  sub: '110169484474386276334',
  email: 'Staff@Step.Example',
  email_verified: true,
  hd: 'step.example',
  iat: NOW / 1000 - 10,
  exp: NOW / 1000 + 3600,
};

function auth(invited = new Set(['staff@step.example'])) {
  return googleIdTokenAuth({
    clientId: CLIENT,
    domains: ['step.example'],
    invited: () => invited,
    admins: new Set(['staff@step.example']),
    keys: async () => [{ ...publicKey.export({ format: 'jwk' }), kid: KID }],
    now: () => NOW,
  });
}

test('an invited, verified Google account of the organization signs in with a stable id', async () => {
  assert.deepEqual(await auth()(token(valid)), {
    userId: 'g110169484474386276334',
    email: 'staff@step.example',
    admin: true,
  });
});

test('every other token is refused', async () => {
  const check = auth();
  const cases: [string, string | undefined][] = [
    ['no header', undefined],
    ['not a bearer', 'Basic abc'],
    ['malformed', 'Bearer not-a-token'],
    ['another audience', token({ ...valid, aud: 'someone-else' })],
    ['another issuer', token({ ...valid, iss: 'https://evil.example' })],
    ['expired', token({ ...valid, exp: NOW / 1000 - 3600 })],
    ['issued in the future', token({ ...valid, iat: NOW / 1000 + 3600 })],
    ['email not verified', token({ ...valid, email_verified: false })],
    ['personal Google account', token({ ...valid, hd: undefined, email: 'staff@gmail.com' })],
    ['other workspace domain', token({ ...valid, hd: 'evil.example' })],
    ['email outside the domain', token({ ...valid, email: 'staff@evil.example' })],
    ['not invited', token({ ...valid, email: 'stranger@step.example' })],
    ['odd subject', token({ ...valid, sub: '../../root' })],
    ['signed by another key', token(valid, { key: other.privateKey })],
    ['unknown key id', token(valid, { kid: 'other' })],
    ['another algorithm', token(valid, { alg: 'HS256' })],
  ];
  for (const [name, header] of cases) assert.equal(await check(header), null, name);
  // Changing the body after signing breaks the signature.
  const [head, , signature] = token(valid).slice(7).split('.');
  assert.equal(
    await check(`Bearer ${head}.${b64({ ...valid, email: 'boss@step.example' })}.${signature}`),
    null,
  );
});

test('removing someone from the invite list takes effect on their next request', async () => {
  const invited = new Set(['staff@step.example']);
  const check = auth(invited);
  assert.ok(await check(token(valid)));
  invited.delete('staff@step.example');
  assert.equal(await check(token(valid)), null);
});
