// Reads an authorized local checkout; never writes corpus questions or answers.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { OrganizationKnowledge } from '../packages/harness-core/vendor/knowledge.ts';
const { values } = parseArgs({ options: { source: { type: 'string' }, pack: { type: 'string' } } });
if (!values.source || !values.pack)
  throw new Error('Use --source authorized-checkout --pack private-export.json');
const pack = JSON.parse(await readFile(values.pack, 'utf8'));
const knowledge = new OrganizationKnowledge(
  pack.sources
    .filter((s: { source_key: string }) => !s.source_key.startsWith('__'))
    .map((s: { source_key: string; title: string; body: string; provenance: object }) => ({
      ...s.provenance,
      id: s.source_key,
      title: s.title,
      body: s.body,
    })),
);
const corpus = JSON.parse(
  await readFile(resolve(values.source, 'desktop/eval/knowledge-questions.json'), 'utf8'),
);
let original = 0,
  buyer = 0;
for (const [list, kind] of [
  [corpus.questions, 'original'],
  [corpus.receiptBuyerIdentityQuestions, 'buyer'],
] as const) {
  for (const { q, doc } of list) {
    const found = await knowledge.search(q),
      ok = doc === 'none' ? !found.length : [doc].flat().includes(found[0]?.id);
    assert.ok(ok, 'UPSTREAM_RETRIEVAL_REGRESSION');
    if (kind === 'original') original++;
    else {
      assert.match(found[0].text, /0994000423179|0-9940-00423-17-9/);
      buyer++;
    }
  }
}
assert.equal(original, 61);
assert.equal(buyer, 3);
console.log(
  JSON.stringify({
    sourceCommit: pack.sourceCommit,
    originalRetrieval: { passed: original, total: 61 },
    buyerIdentity: { passed: buyer, total: 3 },
    liveAnswerAccuracy: 'not measured',
  }),
);
