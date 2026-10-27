import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  documentExcerpts,
  parseSelection,
  selectionCatalog,
} from '../packages/harness-core/src/reference-selection.ts';

const body = [
  '# ดัชนีสังเคราะห์',
  'สาระสังเคราะห์',
  '## หมวด 1 การจ้าง',
  'SYNTHETIC_HIRING',
  '## หมวด 4 การลา',
  '### 4.2 การลาป่วย',
  'SYNTHETIC_SICK',
  '### 4.4 การลาพักผ่อน',
  'SYNTHETIC_VACATION',
  '## หมวด 5 วินัย',
  'SYNTHETIC_DISCIPLINE',
].join('\n');
const doc = { id: 'synthetic', title: 'ดัชนีสังเคราะห์', path: 'docs/synthetic.md', body };

test('a chosen chapter brings its clauses and stops at the next chapter', () => {
  const [section, ...rest] = documentExcerpts(doc, ['หมวด 4 การลา'], 'ลาได้กี่วัน');
  assert.equal(rest.length, 0);
  assert.equal(section.heading, 'หมวด 4 การลา');
  assert.match(section.text, /SYNTHETIC_SICK[\s\S]*SYNTHETIC_VACATION/);
  assert.doesNotMatch(section.text, /SYNTHETIC_DISCIPLINE|SYNTHETIC_HIRING/);
});

test('a clause inside a chosen chapter is not repeated; a partial heading still matches', () => {
  const sections = documentExcerpts(doc, ['4.4 การลาพักผ่อน', 'หมวด 4'], 'ลาพักผ่อน');
  assert.deepEqual(
    sections.map((s) => s.heading),
    ['หมวด 4 การลา'],
  );
});

test('without a usable heading the sections sharing the question words are read', () => {
  const sections = documentExcerpts(doc, ['ไม่มีหัวข้อนี้'], 'วินัย');
  assert.equal(sections[0].heading, 'หมวด 5 วินัย');
});

test('excerpts stay within the character budget', () => {
  assert.equal(documentExcerpts(doc, ['หมวด 4 การลา'], '', 10).length, 0);
});

test('the AI choice keeps only registered documents and Skills, at most two documents', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(
    parseSelection(
      'ผลลัพธ์ ```json\n{"documents":[{"id":"a","sections":["x",1]},"b",{"id":"zz"},{"id":"c"}],"skill":"s1"}\n```',
      ids,
      ['s1'],
    ),
    {
      documents: [
        { id: 'a', sections: ['x'] },
        { id: 'b', sections: [] },
      ],
      skill: 's1',
    },
  );
  assert.deepEqual(parseSelection('{"documents":[],"skill":"made-up"}', ids, ['s1']), { documents: [] });
  assert.deepEqual(parseSelection('ไม่ใช่ JSON', ids, ['s1']), { documents: [] });
});

test('the catalog lists each document with its headings and each Skill with its purpose', () => {
  const text = selectionCatalog(
    [{ id: 'synthetic', title: 'ดัชนี', path: 'p', summary: 'สาระ', sections: ['หมวด 4 การลา'] }],
    [
      {
        id: '1',
        skill_key: 'policy',
        title: 'ตอบระเบียบ',
        description: 'ใช้ตอบสิทธิ',
        instructions: '',
        metadata: {},
        source_version: 't',
      },
    ],
  );
  assert.match(text, /- synthetic \| ดัชนี \| สาระ\n {2}หัวข้อ: หมวด 4 การลา/);
  assert.match(text, /- policy \| ตอบระเบียบ \| ใช้ตอบสิทธิ/);
});
