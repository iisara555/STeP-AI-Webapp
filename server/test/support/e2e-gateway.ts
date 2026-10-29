// A Gateway for the browser checks of Cloud Workspace mode (test/e2e/cloud-workspace.spec.ts). Real HTTP routes,
// runs and event stream; the runtime streams a scripted answer over a few seconds and no AI provider is called.
// It accepts one synthetic credential, never a Google account.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Authenticator } from '../../src/gateway/auth.ts';
import { createGateway } from '../../src/gateway/http.ts';
import { RunService } from '../../src/gateway/runs.ts';
import type {
  AskResult,
  ConversationMessage,
  RuntimeDriver,
  RuntimeEvent,
} from '../../src/workspace/contract.ts';
import { RuntimeManager } from '../../src/workspace/manager.ts';

export const E2E_GATEWAY_PORT = 8799;
export const E2E_TOKEN_SUB = 'e2e-employee';
const ORIGIN = process.env.STEP_E2E_ORIGIN ?? 'http://127.0.0.1:5175';
export const ANSWER = ['ติดต่อฝ่ายบุคคล', 'ได้ทางระบบ HR ', 'และอีเมลของทีม HD ', '(คำตอบสังเคราะห์)'];

function scriptedDriver(): RuntimeDriver {
  const conversations = new Map<string, { title: string; messages: ConversationMessage[] }>();
  const running = new Map<string, () => void>();
  let next = 0;
  return {
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
  };
}

const dataRoot = await mkdtemp(join(tmpdir(), 'step-e2e-gateway-'));
const manager = new RuntimeManager({ dataRoot, driver: scriptedDriver() });
const authenticate: Authenticator = async (header) => {
  const payload = /^Bearer [^.]+\.([^.]+)\.[^.]+$/.exec(header ?? '')?.[1];
  if (!payload) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return claims.sub === E2E_TOKEN_SUB
    ? { userId: E2E_TOKEN_SUB, email: 'e2e@step.example', admin: false }
    : null;
};
const audit = () => {};
createGateway({ manager, runs: new RunService(manager, audit), authenticate, audit, origin: ORIGIN }).listen(
  E2E_GATEWAY_PORT,
  '127.0.0.1',
);
