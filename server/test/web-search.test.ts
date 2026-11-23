import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, serverPolicy, type Runtime } from '../src/engine.ts';
import {
  localSearchUrl,
  passages,
  publicRequest,
  runWebFirst,
  searchingAdapter,
  searchQuery,
  webEvidence,
} from '../src/web-search/evidence.ts';
import { rankResults, SearchFront, searchServer, trustedDomain } from '../src/web-search/service.ts';
import { runtimeEnv } from '../src/workspace/process-driver.ts';

// Synthetic search results and pages only: nothing here leaves the process.
const raw = [
  { title: 'ข่าววันหยุด 2569', url: 'https://news.example.com/a#top', content: 'สรุปวันหยุด' },
  { title: 'ประกาศวันหยุดราชการ พ.ศ. 2569', url: 'https://www.soc.go.th/holiday', content: 'มติคณะรัฐมนตรี' },
  { title: 'ซ้ำ', url: 'https://news.example.com/a', content: 'ซ้ำ' },
  { title: 'ไม่ใช่เว็บ', url: 'javascript:alert(1)', content: '' },
  { title: 'มช.', url: 'https://www.cmu.ac.th/th/news', content: 'ปฏิทิน' },
  { title: '', url: 'https://empty.example.com/', content: 'ไม่มีชื่อ' },
];

test('official domains come first, in SearXNG order; duplicates, non-web links and untitled results are dropped', () => {
  assert.equal(trustedDomain('www.soc.go.th'), true);
  assert.equal(trustedDomain('step.cmu.ac.th'), true);
  assert.equal(trustedDomain('evilgo.th.example.com'), false);
  assert.equal(trustedDomain('notgo.th'), false);
  const ranked = rankResults(raw);
  assert.deepEqual(
    ranked.map((r) => r.url),
    ['https://www.soc.go.th/holiday', 'https://www.cmu.ac.th/th/news', 'https://news.example.com/a'],
  );
  assert.deepEqual(
    ranked.map((r) => r.trusted),
    [true, true, false],
  );
});

const clock = () => {
  let now = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    slept,
    advance: (ms: number) => (now += ms),
  };
};

test('the search front caches, shares a running search, paces SearXNG and refuses a wait that is too long', async () => {
  const time = clock();
  const asked: string[] = [];
  const front = new SearchFront({
    searxngUrl: 'http://127.0.0.1:8888',
    minGapMs: 2000,
    perMinute: 3,
    maxWaitMs: 30_000,
    now: time.now,
    sleep: time.sleep,
    fetchJson: async (url) => {
      asked.push(new URL(url).searchParams.get('q')!);
      return { results: raw };
    },
  });
  const [a, b] = await Promise.all([front.search('วันหยุด  ราชการ'), front.search('วันหยุด ราชการ')]);
  assert.equal(asked.length, 1, 'one running search is shared');
  assert.equal(a.query, 'วันหยุด ราชการ');
  assert.equal(b.results[0].trusted, true);
  assert.equal((await front.search('วันหยุด ราชการ')).cached, true);
  assert.equal(asked.length, 1);
  await front.search('คำถามสอง');
  await front.search('คำถามสาม');
  assert.deepEqual(time.slept, [2000, 2000], 'at least two seconds between SearXNG calls');
  // Three calls in this minute already: the fourth would wait about a minute, longer than maxWaitMs.
  await assert.rejects(() => front.search('คำถามสี่'), /WEB_SEARCH_BUSY/);
  time.advance(61_000);
  await front.search('คำถามสี่');
  await assert.rejects(() => front.search(''), /WEB_SEARCH_QUERY_LIMIT/);
  await assert.rejects(() => front.search('x'.repeat(301)), /WEB_SEARCH_QUERY_LIMIT/);
  assert.throws(
    () => new SearchFront({ searxngUrl: 'http://10.0.0.5:8888' }),
    /WEB_SEARCH_UPSTREAM_NOT_LOCAL/,
  );
});

test('without an official page in the results, the front asks once more within government sites', async () => {
  const time = clock();
  const asked: string[] = [];
  const front = new SearchFront({
    searxngUrl: 'http://localhost:8888',
    now: time.now,
    sleep: time.sleep,
    fetchJson: async (url) => {
      const q = new URL(url).searchParams.get('q')!;
      asked.push(q);
      return {
        results: q.endsWith('site:go.th')
          ? [{ title: 'กรมอุตุนิยมวิทยา', url: 'https://www.tmd.go.th/forecast', content: 'พยากรณ์' }]
          : [{ title: 'บล็อก', url: 'https://blog.example.com/', content: 'อากาศ' }],
      };
    },
  });
  const answer = await front.search('พยากรณ์อากาศ เชียงใหม่');
  assert.deepEqual(asked, ['พยากรณ์อากาศ เชียงใหม่', 'พยากรณ์อากาศ เชียงใหม่ site:go.th']);
  assert.deepEqual(
    answer.results.map((r) => r.domain),
    ['tmd.go.th', 'blog.example.com'],
  );
});

test('the search front answers JSON on loopback and reports codes, never the query', async () => {
  const front = new SearchFront({
    searxngUrl: 'http://127.0.0.1:8888',
    minGapMs: 0,
    fetchJson: async () => ({ results: raw }),
  });
  const server = searchServer(front);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as any).port;
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/search?q=${encodeURIComponent('วันหยุดราชการ')}`);
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as any).results[0].domain, 'soc.go.th');
    const bad = await fetch(`http://127.0.0.1:${port}/search?q=`);
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'WEB_SEARCH_QUERY_LIMIT' });
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/search`, { method: 'POST' })).status, 405);
  } finally {
    server.close();
  }
});

test('the runtime accepts only a loopback search front and finds the question in the engine search prompt', () => {
  assert.equal(localSearchUrl('http://127.0.0.1:8890'), 'http://127.0.0.1:8890');
  assert.equal(localSearchUrl('http://localhost:8890/'), 'http://localhost:8890');
  for (const bad of [
    'https://search.example.com',
    'http://10.0.0.2:8890',
    'http://u:p@127.0.0.1:1',
    'file:///x',
    '',
  ])
    assert.equal(localSearchUrl(bad), undefined, bad);
  assert.equal(publicRequest('rules\n\nPublic request:\nวันหยุดราชการปีนี้'), 'วันหยุดราชการปีนี้');
  assert.equal(publicRequest('no marker'), '');
  assert.ok(searchQuery('ก '.repeat(400)).length <= 300);
  assert.deepEqual(
    runtimeEnv({ workspaceId: 'w', dir: '/d', filesDir: '/d/files' } as any).STEP_WEB_SEARCH_URL,
    undefined,
  );
  const before = process.env.STEP_WEB_SEARCH_URL;
  try {
    process.env.STEP_WEB_SEARCH_URL = 'http://127.0.0.1:8890';
    assert.equal(
      runtimeEnv({ workspaceId: 'w', dir: '/d' } as any).STEP_WEB_SEARCH_URL,
      'http://127.0.0.1:8890',
    );
    process.env.STEP_WEB_SEARCH_URL = 'https://search.example.com';
    assert.equal(runtimeEnv({ workspaceId: 'w', dir: '/d' } as any).STEP_WEB_SEARCH_URL, undefined);
  } finally {
    if (before === undefined) delete process.env.STEP_WEB_SEARCH_URL;
    else process.env.STEP_WEB_SEARCH_URL = before;
  }
});

test('evidence keeps the lines that answer the question and stays within its size', async () => {
  const page = [
    'เมนูหลัก หน้าแรก ติดต่อเรา',
    'ประกาศวันหยุดราชการประจำปี 2569',
    'วันขึ้นปีใหม่ 1 มกราคม 2569',
    'วันมาฆบูชา 3 มีนาคม 2569',
    'ข้อมูลอื่นที่ไม่เกี่ยวข้องกับเรื่องนี้เลย',
  ].join('\n');
  const picked = passages(page, 'วันหยุดราชการ 2569');
  assert.match(picked, /ประกาศวันหยุดราชการประจำปี 2569/);
  assert.match(picked, /มาฆบูชา/);
  assert.doesNotMatch(picked, /เมนูหลัก/);
  const pages: string[] = [];
  const evidence = await webEvidence('วันหยุดราชการ 2569', new AbortController().signal, {
    url: 'http://127.0.0.1:8890',
    now: () => new Date('2026-11-23T00:00:00Z'),
    fetchJson: async (url) => {
      assert.equal(new URL(url).searchParams.get('q'), 'วันหยุดราชการ 2569');
      return { query: 'q', cached: false, at: '', results: rankResults(raw) };
    },
    fetchPage: async (url) => {
      pages.push(url);
      if (url.includes('cmu')) throw new Error('WEB_FETCH_FAILED');
      return { url, text: `<html><body><main>${page.split('\n').join('<br>')}</main></body></html>` };
    },
  });
  assert.deepEqual(pages, ['https://www.soc.go.th/holiday', 'https://www.cmu.ac.th/th/news']);
  assert.match(evidence, /^Public web search results \(organization search, 2026-11-23\)/);
  assert.match(
    evidence,
    /\[ประกาศวันหยุดราชการ พ\.ศ\. 2569\]\(https:\/\/www\.soc\.go\.th\/holiday\) \[official\]/,
  );
  assert.match(evidence, /มาฆบูชา 3 มีนาคม 2569/);
  // The page that could not be read stays a snippet.
  assert.match(evidence, /Other results[\s\S]*cmu\.ac\.th[\s\S]*news\.example\.com/);
  const small = await webEvidence('วันหยุดราชการ 2569', new AbortController().signal, {
    url: 'http://127.0.0.1:8890',
    maxChars: 300,
    fetchJson: async () => ({ query: 'q', cached: false, at: '', results: rankResults(raw) }),
    fetchPage: async (url) => ({ url, text: '<p>' + 'วันหยุดราชการ 2569 '.repeat(200) + '</p>' }),
  });
  assert.ok(small.length <= 300);
  await assert.rejects(
    () =>
      webEvidence('x', new AbortController().signal, {
        url: 'http://127.0.0.1:8890',
        fetchJson: async () => ({ query: 'x', cached: false, at: '', results: [] }),
      }),
    /WEB_SEARCH_NO_RESULTS/,
  );
});

test('the searching adapter answers only the engine search call and passes every other call through', async () => {
  const stages: string[] = [];
  const calls: string[] = [];
  const adapter = searchingAdapter(
    {
      run: async (prompt) => {
        calls.push(prompt);
        return 'จาก provider';
      },
    },
    {
      url: 'http://127.0.0.1:8890',
      fetchJson: async () => ({ query: 'q', cached: false, at: '', results: rankResults(raw) }),
      fetchPage: async (url) => ({ url, text: '<p>วันหยุดราชการ 2569</p>' }),
    },
  );
  const context: any = {
    signal: new AbortController().signal,
    emit() {},
    onWebActivity: (s: string) => stages.push(s),
  };
  assert.equal(await adapter.run('ถามทั่วไป', {} as any, context), 'จาก provider');
  const evidence = await adapter.run('Public request:\nวันหยุดราชการ 2569', {} as any, {
    ...context,
    webSearch: true,
  });
  assert.match(evidence, /soc\.go\.th/);
  assert.deepEqual(calls, ['ถามทั่วไป'], 'the search call never reaches the provider');
  assert.deepEqual(stages, ['search', 'read', 'complete']);
});

// The whole Workspace path with a synthetic provider: a current public question is searched first and answered from
// the evidence, while the read-only tool loop stays on for every other question.
test('a current public question in a Workspace is answered from the organization search', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-web-search-'));
  const files = join(dir, 'files');
  await mkdir(files);
  const answers: { system: string; prompt: string }[] = [];
  const searches: string[] = [];
  const runtime: Runtime = async () => ({
    adapter: searchingAdapter(
      {
        run: async (prompt: string, _c: unknown, context: any) => {
          answers.push({ system: context.system || '', prompt });
          return 'อัตราแลกเปลี่ยนตามแหล่งข้อมูล';
        },
      } as any,
      {
        url: 'http://127.0.0.1:8890',
        fetchJson: async (url) => {
          searches.push(new URL(url).searchParams.get('q')!);
          return {
            query: 'q',
            cached: false,
            at: '',
            results: rankResults([
              {
                title: 'อัตราแลกเปลี่ยน ธปท.',
                url: 'https://www.bot.or.th/th/statistics/exchange-rate.html',
                content: '',
              },
            ]),
          };
        },
        fetchPage: async (url) => ({
          url,
          text: '<main><p>อัตราแลกเปลี่ยน ดอลลาร์ สรอ. 33.10 บาท</p></main>',
        }),
      },
    ),
    context: { cwd: files, env: {} },
  });
  const engine = await createEngine({
    dataDir: dir,
    runtime,
    policy: serverPolicy({ workspaceTools: true }),
    workspaceTools: { filesDir: files },
    publicSearch: async () => '',
  });
  engine.store.put('connection', 'central', {
    id: 'central',
    provider: 'compatible',
    mode: 'api',
    ready: true,
  });
  const question = 'อัตราแลกเปลี่ยนดอลลาร์วันนี้เท่าไร';
  try {
    const first = engine.store.create('central', 'cc');
    await engine.work.run(first.id, question, '', true, undefined, 'chat');
    assert.equal(searches.length, 0, 'with the tool loop on, the engine leaves searching to the AI');
    assert.ok(answers.at(-1)!.system.includes('Tools in this Cloud Workspace'));

    answers.length = 0;
    const second = engine.store.create('central', 'cc');
    await runWebFirst(() => engine.work.run(second.id, question, '', true, undefined, 'chat'));
    const done = engine.store.session(second.id);
    assert.equal(done.status, 'review', JSON.stringify(done.runs?.at(-1)));
    assert.deepEqual(searches, [question]);
    const last = answers.at(-1)!;
    assert.match(last.prompt, /<web_evidence>[\s\S]*bot\.or\.th[\s\S]*33\.10/);
    assert.ok(!last.system.includes('Tools in this Cloud Workspace'));

    // The next question in the same process is back on the tool loop.
    answers.length = 0;
    const third = engine.store.create('central', 'cc');
    await engine.work.run(third.id, 'ชื่อผู้ซื้อในใบเสร็จต้องเป็นอะไร', '', true, undefined, 'chat');
    assert.ok(answers.some((a) => a.system.includes('Tools in this Cloud Workspace')));
  } finally {
    engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
