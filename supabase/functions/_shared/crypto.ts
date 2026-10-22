const encoder = new TextEncoder();
function base64(bytes: Uint8Array) {
  let value = '';
  for (const b of bytes) value += String.fromCharCode(b);
  return btoa(value);
}
function decode(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export function randomToken() {
  return base64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
export async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export async function pkce(value: string) {
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
async function key(secret: string) {
  const bytes = decode(secret);
  if (bytes.length !== 32) throw new Error('CREDENTIAL_KEY_INVALID');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(value: unknown, secret: string, binding: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(binding) },
    await key(secret),
    encoder.encode(JSON.stringify(value)),
  );
  return 'v1.' + base64(iv) + '.' + base64(new Uint8Array(ciphertext));
}
export async function decrypt<T>(value: string, secret: string, binding: string): Promise<T> {
  const [version, iv, data] = value.split('.');
  if (version !== 'v1' || !iv || !data) throw new Error('CREDENTIAL_INVALID');
  const bytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(iv), additionalData: encoder.encode(binding) },
    await key(secret),
    decode(data),
  );
  return JSON.parse(new TextDecoder().decode(bytes));
}
