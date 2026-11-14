import assert from 'node:assert/strict';
import test from 'node:test';
import { currentRunResult } from '../src/workspace/current-run-result.ts';

const old = {
  messages: [{ role: 'assistant' as const, text: 'old answer', docSources: ['old document'] }],
  runs: [{ id: 'old', outcome: 'review' as const }],
};

test('an early return with the old review snapshot does not return the old answer or sources', () => {
  assert.deepEqual(currentRunResult('s', old, old), {
    sessionId: 's',
    status: 'error',
    code: 'RUN_FAILED',
    sources: [],
  });
});

test('only the new reviewed assistant message supplies the answer and sources', () => {
  const done = {
    ...old,
    messages: [...old.messages, { role: 'assistant' as const, text: 'new', docSources: ['new document'] }],
    runs: [...old.runs, { id: 'new', outcome: 'review' }],
  };
  assert.deepEqual(currentRunResult('s', old, done), {
    sessionId: 's',
    status: 'review',
    answer: 'new',
    sources: ['new document'],
  });
  assert.deepEqual(
    currentRunResult('s', old, {
      ...done,
      messages: [...old.messages, { role: 'assistant', text: 'ungrounded' }],
    }),
    { sessionId: 's', status: 'review', answer: 'ungrounded', sources: [] },
  );
});

test('failed and cancelled traces never return partial answers or old sources', () => {
  for (const outcome of ['error', 'cancelled']) {
    const done = {
      messages: [
        ...old.messages,
        { role: 'assistant' as const, text: 'partial', docSources: ['partial document'] },
      ],
      runs: [...old.runs, { id: 'new', outcome, code: 'SYNTHETIC' }],
    };
    assert.deepEqual(currentRunResult('s', old, done), {
      sessionId: 's',
      status: outcome,
      code: 'SYNTHETIC',
      sources: [],
    });
  }
});

test('a new review trace without a new assistant is not a successful answer', () => {
  assert.deepEqual(
    currentRunResult('s', old, { ...old, runs: [...old.runs, { id: 'new', outcome: 'review' }] }),
    { sessionId: 's', status: 'error', code: 'RUN_FAILED', sources: [] },
  );
});
