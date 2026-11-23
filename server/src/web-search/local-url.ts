// No imports on purpose: the Gateway's process driver uses this without loading the engine.
/** A search front URL is accepted only on loopback over http: the front itself is never exposed. */
export function localSearchUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
