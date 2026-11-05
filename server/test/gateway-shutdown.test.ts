import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatewayShutdown } from '../src/gateway/shutdown.ts';

test('gateway reports a runtime cleanup failure with a nonzero exit', async () => {
  const failure = new Error('cleanup failed');
  const events: string[] = [];
  const shutdown = gatewayShutdown(
    () => events.push('stop accepting'),
    async () => {
      throw failure;
    },
    () => events.push('close stores'),
    (code) => events.push(`exit ${code}`),
  );
  await assert.rejects(shutdown(), failure);
  assert.deepEqual(events, ['stop accepting', 'close stores', 'exit 1']);
});

test('gateway closes once and exits successfully after cleanup', async () => {
  const events: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  const shutdown = gatewayShutdown(
    () => events.push('stop accepting'),
    () => pending,
    () => events.push('close stores'),
    (status) => events.push(`exit ${status}`),
  );
  const first = shutdown();
  const second = shutdown();
  assert.deepEqual(events, ['stop accepting']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['stop accepting', 'close stores', 'exit 0']);
});
