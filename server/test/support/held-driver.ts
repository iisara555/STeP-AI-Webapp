// Test support: a Workspace runtime that answers only when a test says so, standing for a long job. Conversations
// live in memory; nothing reaches an AI provider.
import assert from 'node:assert/strict';
import type {
  AskResult,
  ConversationMessage,
  RuntimeDriver,
  RuntimeEvent,
} from '../../src/workspace/contract.ts';

/**
 * A runtime that answers only when the test says so, to stand for a long job. Every conversation lives in memory
 * per Workspace; nothing reaches an AI provider.
 */
export function heldDriver() {
  const conversations = new Map<string, ConversationMessage[]>();
  const pending = new Map<string, (result: AskResult) => void>();
  /** Answers given before the runtime received the question; delivered as soon as it does. */
  const early = new Map<string, AskResult>();
  const deliver = (result: AskResult) => {
    if (result.answer) conversations.get(result.sessionId)!.push({ role: 'assistant', text: result.answer });
  };
  const settle = (sessionId: string, result: AskResult) => {
    const done = pending.get(sessionId);
    if (!done) return void early.set(sessionId, result);
    pending.delete(sessionId);
    deliver(result);
    done(result);
  };
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const cancels: string[] = [];
  let next = 0;
  const driver: RuntimeDriver = {
    async start() {
      let exit: (code: number | null) => void = () => {};
      return {
        health: async () => ({ ok: true, workspaceId: '' }),
        onExit: (listener) => void (exit = listener),
        onEvent: (listener) => void listeners.add(listener),
        stop: async () => exit(0),
        call: (async (method: string, params: any) => {
          if (method === 'connect') return { ok: true };
          if (method === 'newConversation') {
            const sessionId = `c${++next}`;
            conversations.set(sessionId, []);
            return { sessionId };
          }
          if (method === 'ask') {
            conversations.get(params.sessionId)!.push({ role: 'user', text: params.text });
            const ready = early.get(params.sessionId);
            early.delete(params.sessionId);
            if (ready) deliver(ready);
            return ready ?? new Promise((done) => pending.set(params.sessionId, done));
          }
          if (method === 'cancel') {
            cancels.push(params.sessionId);
            assert.ok(pending.has(params.sessionId), 'a cancel arrives after the question it cancels');
            settle(params.sessionId, {
              sessionId: params.sessionId,
              status: 'cancelled',
              code: 'CANCELLED',
              sources: [],
            });
            return { ok: true };
          }
          if (method === 'messages') return conversations.get(params.sessionId) ?? [];
          if (method === 'conversations')
            return [...conversations.keys()].map((id) => ({ id, title: '', status: 'review' }));
          throw new Error('UNKNOWN_METHOD');
        }) as any,
      };
    },
  };
  return {
    driver,
    cancels,
    say(sessionId: string, text: string) {
      for (const listener of listeners) listener({ sessionId, type: 'delta', text });
    },
    answer(sessionId: string, text: string) {
      this.say(sessionId, text);
      settle(sessionId, { sessionId, status: 'review', answer: text, sources: ['hr-service-channels'] });
    },
  };
}
