import type { Session } from '../../../harness/desktop/src/types.ts';
import type { AskResult } from './contract.ts';

type Snapshot = {
  messages: Array<Pick<Session['messages'][number], 'role' | 'text' | 'docSources'>>;
  runs?: Array<Pick<NonNullable<Session['runs']>[number], 'id' | 'outcome' | 'code'>>;
};

/** Map only artifacts created by this invocation, not a previous session review. */
export function currentRunResult(sessionId: string, before: Snapshot, done: Snapshot): AskResult {
  const trace = done.runs?.at(-1);
  const currentTrace = trace && trace.id !== before.runs?.at(-1)?.id ? trace : undefined;
  const assistant = done.messages.slice(before.messages.length).findLast((m) => m.role === 'assistant');
  const completed = currentTrace?.outcome === 'review' && !!assistant;
  return {
    sessionId,
    status: completed ? 'review' : currentTrace?.outcome === 'cancelled' ? 'cancelled' : 'error',
    ...(completed && assistant.text ? { answer: assistant.text } : {}),
    ...(completed ? {} : { code: currentTrace?.code || 'RUN_FAILED' }),
    sources: completed ? (assistant.docSources ?? []) : [],
  };
}
