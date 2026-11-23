// npm run web-search: the shared search front on loopback (see service.ts and docs/web-search.md).
//   STEP_SEARXNG_URL       SearXNG on loopback (default http://127.0.0.1:8888)
//   STEP_WEB_SEARCH_PORT   this front's port (default 8890), always bound to 127.0.0.1
//   STEP_WEB_TRUSTED       optional comma list of trusted domain suffixes, replacing the default list
import { DEFAULT_TRUSTED, SearchFront, searchServer } from './service.ts';

const port = Number(process.env.STEP_WEB_SEARCH_PORT || 8890);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('STEP_WEB_SEARCH_PORT');
const trusted = process.env.STEP_WEB_TRUSTED?.split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const front = new SearchFront({
  searxngUrl: process.env.STEP_SEARXNG_URL || 'http://127.0.0.1:8888',
  trusted: trusted?.length ? trusted : DEFAULT_TRUSTED,
});
const server = searchServer(front);
server.listen(port, '127.0.0.1', () => console.log(`web search front on http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
