// A runtime for the browser checks: it streams a scripted answer over a few seconds; no AI provider is called.
import type {
  AskResult,
  ConversationMessage,
  RuntimeDriver,
  RuntimeEvent,
} from '../../src/workspace/contract.ts';

export const ANSWER = ['ติดต่อฝ่ายบุคคล', 'ได้ทางระบบ HR ', 'และอีเมลของทีม HD ', '(คำตอบสังเคราะห์)'];

export function scriptedDriver(): RuntimeDriver {
  const conversations = new Map<string, { title: string; messages: ConversationMessage[] }>();
  const running = new Map<string, () => void>();
  let next = 0;
  const driver: RuntimeDriver = {
    async start() {
      const listeners = new Set<(event: RuntimeEvent) => void>();
      let exit: (code: number | null) => void = () => {};
      const emit = (event: RuntimeEvent) => listeners.forEach((listener) => listener(event));
      return {
        health: async () => ({ ok: true, workspaceId: '' }),
        onExit: (listener) => void (exit = listener),
        onEvent: (listener) => void listeners.add(listener),
        stop: async () => exit(0),
        call: (async (method: string, params: any) => {
          if (method === 'connect') return { ok: true };
          if (method === 'newConversation') {
            const sessionId = `e2e${++next}`;
            conversations.set(sessionId, { title: '', messages: [] });
            return { sessionId };
          }
          if (method === 'conversations')
            return [...conversations].map(([id, c]) => ({ id, title: c.title, status: 'review' }));
          if (method === 'messages') return conversations.get(params.sessionId)?.messages ?? [];
          if (method === 'cancel') {
            running.get(params.sessionId)?.();
            return { ok: true };
          }
          if (method === 'ask') {
            const conversation = conversations.get(params.sessionId)!;
            conversation.title ||= params.text.slice(0, 60);
            conversation.messages.push({ role: 'user', text: params.text });
            return new Promise<AskResult>((done) => {
              let index = 0;
              const timer = setInterval(() => {
                if (index < ANSWER.length)
                  return emit({ sessionId: params.sessionId, type: 'delta', text: ANSWER[index++] });
                clearInterval(timer);
                running.delete(params.sessionId);
                const answer = ANSWER.join('');
                conversation.messages.push({ role: 'assistant', text: answer });
                done({
                  sessionId: params.sessionId,
                  status: 'review',
                  answer,
                  sources: ['HR Service Channels · ช่องทางตามเรื่อง'],
                });
              }, 900);
              running.set(params.sessionId, () => {
                clearInterval(timer);
                running.delete(params.sessionId);
                done({ sessionId: params.sessionId, status: 'cancelled', code: 'CANCELLED', sources: [] });
              });
            });
          }
          throw new Error('UNKNOWN_METHOD');
        }) as any,
      };
    },
    startWithAdmission(spec, admit) {
      let started!: ReturnType<RuntimeDriver['start']>;
      admit(() => {
        started = driver.start(spec);
      });
      return started;
    },
  };
  return driver;
}
