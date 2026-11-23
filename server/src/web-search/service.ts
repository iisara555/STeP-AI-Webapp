// Shared front for the organization's own SearXNG (deploy/web-search). Every Workspace runtime on this machine asks
// here, never SearXNG directly, so one cache and one pace protect the search engines SearXNG queries from being
// flooded (they block a machine that searches too fast). Binds to loopback only; the result is public data.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  trusted: boolean;
};
export type SearchAnswer = { query: string; results: SearchResult[]; cached: boolean; at: string };

export type SearchServiceOptions = {
  /** SearXNG on loopback, for example http://127.0.0.1:8888. */
  searxngUrl: string;
  /** Domains ranked first (suffix match): government, universities, the organization itself. */
  trusted?: string[];
  /** How long one query's results are reused. */
  cacheMs?: number;
  cacheEntries?: number;
  /** Minimum gap between two calls to SearXNG, and the most calls in one minute. */
  minGapMs?: number;
  perMinute?: number;
  /** A caller waits at most this long for its turn, then gets WEB_SEARCH_BUSY instead of queueing forever. */
  maxWaitMs?: number;
  fetchJson?: (url: string, signal: AbortSignal) => Promise<any>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_TRUSTED = [
  'go.th',
  'ac.th',
  'or.th',
  'mi.th',
  'cmu.ac.th',
  'step.cmu.ac.th',
  'tmd.go.th',
  'bot.or.th',
  'ratchakitcha.soc.go.th',
];

const loopback = (url: URL) => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);

export function trustedDomain(host: string, trusted: string[] = DEFAULT_TRUSTED) {
  const name = host.toLowerCase().replace(/^www\./, '');
  return trusted.some((suffix) => name === suffix || name.endsWith('.' + suffix));
}

/** One search query as sent upstream: trimmed, single spaces, bounded, no control characters. */
export function normalizeQuery(value: unknown) {
  const query = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!query || query.length > 300 || /[\u0000-\u001f\u007f]/.test(query))
    throw new Error('WEB_SEARCH_QUERY_LIMIT');
  return query;
}

const plain = (value: unknown, limit: number) =>
  String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\[\]\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);

/**
 * SearXNG's own order, with trusted domains moved to the front (their order kept). Only http(s) links, one per URL,
 * at most `limit`.
 */
export function rankResults(raw: any[], trusted: string[] = DEFAULT_TRUSTED, limit = 8): SearchResult[] {
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const item of Array.isArray(raw) ? raw.slice(0, 60) : []) {
    let url: URL;
    try {
      url = new URL(String(item?.url ?? ''));
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    url.hash = '';
    if (seen.has(url.href)) continue;
    const title = plain(item?.title, 300);
    if (!title) continue;
    seen.add(url.href);
    results.push({
      title,
      url: url.href,
      snippet: plain(item?.content, 600),
      domain: url.hostname.replace(/^www\./, ''),
      trusted: trustedDomain(url.hostname, trusted),
    });
  }
  return [...results.filter((r) => r.trusted), ...results.filter((r) => !r.trusted)].slice(0, limit);
}

export class SearchFront {
  private cache = new Map<string, { at: number; answer: SearchAnswer }>();
  private inflight = new Map<string, Promise<SearchAnswer>>();
  private calls: number[] = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly o: Required<Omit<SearchServiceOptions, 'fetchJson'>> & {
    fetchJson: NonNullable<SearchServiceOptions['fetchJson']>;
  };

  constructor(options: SearchServiceOptions) {
    const upstream = new URL(options.searxngUrl);
    if (!loopback(upstream) || upstream.protocol !== 'http:')
      throw new Error('WEB_SEARCH_UPSTREAM_NOT_LOCAL');
    this.o = {
      trusted: DEFAULT_TRUSTED,
      cacheMs: 6 * 60 * 60 * 1000,
      cacheEntries: 500,
      minGapMs: 2000,
      perMinute: 20,
      maxWaitMs: 15_000,
      now: Date.now,
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      fetchJson: async (url, signal) => {
        const response = await fetch(url, { signal, headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error('WEB_SEARCH_UNAVAILABLE');
        return response.json();
      },
      ...options,
    };
  }

  /** Waits for a free slot under both limits; refuses when the wait would be longer than maxWaitMs. */
  private turn() {
    const mine = this.queue.then(async () => {
      for (;;) {
        const now = this.o.now();
        this.calls = this.calls.filter((at) => now - at < 60_000);
        const last = this.calls.at(-1);
        const gap = last === undefined ? 0 : Math.max(0, last + this.o.minGapMs - now);
        const full = this.calls.length >= this.o.perMinute ? this.calls[0] + 60_000 - now : 0;
        const wait = Math.max(gap, full);
        if (wait <= 0) {
          this.calls.push(now);
          return;
        }
        if (wait > this.o.maxWaitMs) throw new Error('WEB_SEARCH_BUSY');
        await this.o.sleep(wait);
      }
    });
    this.queue = mine.catch(() => {});
    return mine;
  }

  private async upstream(query: string, signal: AbortSignal) {
    await this.turn();
    const url = new URL('/search', this.o.searxngUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('language', 'th');
    url.searchParams.set('safesearch', '1');
    const body = await this.o.fetchJson(url.href, AbortSignal.any([signal, AbortSignal.timeout(12_000)]));
    return rankResults(body?.results, this.o.trusted);
  }

  async search(value: unknown, signal: AbortSignal = new AbortController().signal): Promise<SearchAnswer> {
    const query = normalizeQuery(value);
    const key = query.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && this.o.now() - hit.at < this.o.cacheMs) return { ...hit.answer, cached: true };
    const running = this.inflight.get(key);
    if (running) return running;
    const job = (async () => {
      let results = await this.upstream(query, signal);
      // No official page in the first page of results: ask once more within government sites only.
      if (!results.some((r) => r.trusted) && !/\bsite:/i.test(query)) {
        const official = await this.upstream(query + ' site:go.th', signal).catch(() => []);
        const urls = new Set(results.map((r) => r.url));
        results = [...official.filter((r) => r.trusted && !urls.has(r.url)).slice(0, 3), ...results].slice(
          0,
          8,
        );
      }
      const answer: SearchAnswer = {
        query,
        results,
        cached: false,
        at: new Date(this.o.now()).toISOString(),
      };
      if (results.length) {
        this.cache.delete(key);
        this.cache.set(key, { at: this.o.now(), answer });
        while (this.cache.size > this.o.cacheEntries) this.cache.delete(this.cache.keys().next().value!);
      }
      return answer;
    })();
    this.inflight.set(key, job);
    try {
      return await job;
    } finally {
      this.inflight.delete(key);
    }
  }
}

const reply = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** GET /search?q=… and GET /healthz on loopback. Query text is never logged. */
export function searchServer(front: SearchFront): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method !== 'GET') return reply(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (url.pathname === '/healthz') return reply(res, 200, { ok: true });
    if (url.pathname !== '/search') return reply(res, 404, { error: 'NOT_FOUND' });
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      reply(res, 200, await front.search(url.searchParams.get('q'), controller.signal));
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'WEB_SEARCH_UNAVAILABLE';
      reply(res, code === 'WEB_SEARCH_QUERY_LIMIT' ? 400 : code === 'WEB_SEARCH_BUSY' ? 429 : 502, {
        error: code,
      });
    }
  });
}
