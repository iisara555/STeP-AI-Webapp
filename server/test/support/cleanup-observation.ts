import type { SpawnSyncReturns } from 'node:child_process';

// Pure parsers keep host cleanup evidence testable without spawning host commands.
export type ObservationResult = Pick<
  SpawnSyncReturns<string>,
  'status' | 'signal' | 'error' | 'stdout' | 'stderr'
>;

function checkCommand(command: string, result: ObservationResult, statuses: number[]): void {
  if (result.error || result.signal || !statuses.includes(result.status!) || result.stderr.trim())
    throw new Error(
      `${command} observation failed: status=${result.status}; signal=${result.signal}; ${result.error?.message ?? ''}; ${result.stderr}`,
      { cause: result.error },
    );
}

export const parseRunnerPids = (result: ObservationResult): Set<number> => {
  checkCommand('pgrep', result, [0, 1]);
  const text = result.stdout.trim();
  if (result.status === 1) {
    if (text) throw new Error('pgrep observation malformed: no-match status with PID output');
    return new Set();
  }
  const tokens = text.split(/\s+/);
  if (!tokens.every((token) => /^[1-9]\d*$/.test(token) && Number.isSafeInteger(Number(token))))
    throw new Error(
      `pgrep observation malformed: expected positive decimal PIDs, got ${JSON.stringify(result.stdout)}`,
    );
  return new Set(tokens.map(Number));
};

export const parseUnits = (result: ObservationResult): string => {
  checkCommand('systemctl', result, [0]);
  return result.stdout.trim();
};
