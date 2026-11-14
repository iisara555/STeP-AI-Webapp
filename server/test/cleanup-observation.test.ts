import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunnerPids, parseUnits, type ObservationResult } from './support/cleanup-observation.ts';

const output = (extra: Partial<ObservationResult> = {}): ObservationResult => ({
  status: 0,
  signal: null,
  stdout: '',
  stderr: '',
  ...extra,
});

test('cleanup observation: systemctl nonzero is not an empty unit list', () => {
  assert.equal(parseUnits(output()), '');
  for (const status of [1, 2, 127]) {
    for (const stdout of ['', 'step-rt-live.scope loaded active running live\n']) {
      for (const stderr of ['', 'bus unavailable']) {
        assert.throws(() => parseUnits(output({ status, stdout, stderr })), /systemctl.*failed/);
      }
    }
  }
});

test('cleanup observation: spawn errors, timeouts, signals and stderr cannot prove absence', () => {
  for (const parse of [parseRunnerPids, parseUnits]) {
    for (const result of [
      output({ error: Object.assign(new Error('missing command'), { code: 'ENOENT' }) }),
      output({ status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }),
      output({ signal: 'SIGTERM' }),
      output({ status: null, signal: 'SIGKILL' }),
      output({ stderr: 'unexpected diagnostic' }),
    ])
      assert.throws(() => parse(result), /observation failed/);
  }
  assert.throws(
    () => parseRunnerPids(output({ status: 1, stderr: 'not a clean no-match' })),
    /observation failed/,
  );
});

test('cleanup observation: pgrep validates positive safe decimal PIDs and status/output consistency', () => {
  assert.deepEqual(parseRunnerPids(output({ stdout: '123\n456\n123\n' })), new Set([123, 456]));
  for (const stdout of [
    '',
    ' \n',
    'NaN\n',
    '0\n',
    '-1\n',
    '1.5\n',
    '1e3\n',
    '0x10\n',
    '123 junk\n',
    '9007199254740992\n',
  ]) {
    assert.throws(() => parseRunnerPids(output({ stdout })), /pgrep.*malformed/);
  }
  assert.throws(() => parseRunnerPids(output({ status: 1, stdout: '123\n' })), /pgrep.*malformed/);
});

test('cleanup observation: systemctl preserves all nonempty evidence instead of filtering unknown rows', () => {
  for (const text of ['step-rt-live.scope loaded active running live', 'unexpected output']) {
    assert.equal(parseUnits(output({ stdout: `  ${text}\n` })), text);
  }
});

test('cleanup observation: pgrep exit 1 is no match, exit >1 is not emptiness', () => {
  assert.deepEqual(parseRunnerPids(output({ status: 1 })), new Set());
  for (const status of [2, 3, 127]) {
    for (const stderr of ['', 'synthetic pgrep failure']) {
      assert.throws(() => parseRunnerPids(output({ status, stderr })), /pgrep.*failed/);
    }
  }
});
