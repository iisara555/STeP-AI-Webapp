import { LIMITS, assertSafeText } from '../../../packages/harness-core/src/index.ts';
import { requireEnv, type Environment } from './runtime.ts';
export interface ModelUsage {
  input: number;
  output: number;
}
export interface GenerateInput {
  system: string;
  prompt: string;
  json?: boolean;
  image?: { mime: string; data: string };
  signal?: AbortSignal;
  /** Room for a longer answer, at most 8,192 tokens; the caller keeps it within the run's reserved cost. */
  maxOutputTokens?: number;
}
export interface ModelResult {
  text: string;
  usage: ModelUsage;
  truncated: boolean;
}
export async function responseJson(response: Response, max = 1000000) {
  if (Number(response.headers.get('content-length')) > max) throw new Error('PROVIDER_STREAM_INVALID');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('PROVIDER_STREAM_INVALID');
  let text = '',
    length = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max) throw new Error('PROVIDER_STREAM_INVALID');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('PROVIDER_STREAM_INVALID');
  }
}
type Step = 'count' | 'generate' | 'embed';
/**
 * Google's reason for a failed call (e.g. UNAVAILABLE "The model is overloaded" or DEADLINE_EXCEEDED), read from its
 * error body. Google's error text never repeats the request; it is still bounded and stripped of anything key-like.
 */
async function providerReason(response: Response) {
  try {
    const text = (await response.text()).slice(0, 4000);
    const error = JSON.parse(text)?.error;
    return {
      reason: typeof error?.status === 'string' ? error.status.slice(0, 40) : undefined,
      message:
        typeof error?.message === 'string'
          ? error.message.replace(/AIza[\w-]{10,}/g, '[key]').slice(0, 200)
          : undefined,
    };
  } catch {
    return {};
  }
}
/** Logs the step, status, Google's reason and how long the attempt took; never prompt, answer or key. */
function logFailure(
  step: Step,
  status: number,
  ms: number,
  detail: { reason?: string; message?: string },
  retried: boolean,
) {
  console.warn(JSON.stringify({ provider: 'gemini', step, status, ms, ...detail, retried }));
}
function providerError(status: number) {
  return new Error(
    status === 429
      ? 'AI_RATE_LIMIT'
      : status === 401 || status === 403
        ? 'AI_NOT_CONFIGURED'
        : status >= 500
          ? 'AI_BUSY'
          : 'AI_SERVICE_ERROR',
  );
}
export const BUSY_RETRY_MS = 1500;
export function gemini(env: Environment, fetcher: typeof fetch = fetch) {
  const key = requireEnv(env, 'GEMINI_API_KEY');
  const model = env('GEMINI_MODEL') || 'gemini-3.8-flash';
  if (!/^gemini-[a-z0-9.-]+$/.test(model)) throw new Error('AI_NOT_CONFIGURED');
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}`;
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': key };
  // 503 UNAVAILABLE means Google did not process the request (an overloaded model, common on the free tier),
  // so one retry neither repeats work nor costs anything. Every other failure is reported as it came.
  const call = async (step: Step, url: string, init: RequestInit) => {
    let started = Date.now(),
      retried = false;
    let response = await fetcher(url, init);
    if (response.status === 503) {
      logFailure(step, 503, Date.now() - started, await providerReason(response), false);
      await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
      started = Date.now();
      retried = true;
      response = await fetcher(url, init);
    }
    if (!response.ok) {
      const status = response.status;
      logFailure(step, status, Date.now() - started, await providerReason(response), retried);
      throw providerError(status);
    }
    return response;
  };
  return {
    async generate(input: GenerateInput): Promise<ModelResult> {
      assertSafeText(input.prompt);
      const parts: unknown[] = [{ text: input.prompt }];
      if (input.image) parts.push({ inlineData: { mimeType: input.image.mime, data: input.image.data } });
      const contents = [{ role: 'user', parts }];
      const signal = input.signal || AbortSignal.timeout(85000);
      const counted = await call('count', endpoint + ':countTokens', {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          generateContentRequest: {
            model: `models/${model}`,
            contents,
            systemInstruction: { parts: [{ text: input.system }] },
          },
        }),
      });
      const tokens = await responseJson(counted, 20000);
      if (!Number.isInteger(tokens.totalTokens) || tokens.totalTokens > LIMITS.contextTokens)
        throw new Error('CONTEXT_TOO_LARGE');
      const response = await call('generate', endpoint + ':generateContent', {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: input.system }] },
          contents,
          generationConfig: {
            maxOutputTokens: Math.min(8192, input.maxOutputTokens || LIMITS.outputTokens),
            ...(input.json ? { responseMimeType: 'application/json' } : {}),
          },
        }),
      });
      const data = await responseJson(response);
      const candidate = data.candidates?.[0];
      if (!candidate || !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason))
        throw new Error('PROVIDER_STREAM_INVALID');
      const text = Array.isArray(candidate.content?.parts)
        ? candidate.content.parts
            .filter((p: { text?: string; thought?: boolean }) => typeof p.text === 'string' && !p.thought)
            .map((p: { text: string }) => p.text)
            .join('')
        : '';
      if (!text.trim() || text.length > 200000 || (input.json && candidate.finishReason === 'MAX_TOKENS'))
        throw new Error('PROVIDER_STREAM_INVALID');
      assertSafeText(text);
      return {
        text,
        truncated: candidate.finishReason === 'MAX_TOKENS',
        usage: {
          input: data.usageMetadata?.promptTokenCount || tokens.totalTokens,
          output:
            (data.usageMetadata?.candidatesTokenCount || 0) + (data.usageMetadata?.thoughtsTokenCount || 0),
        },
      };
    },
    async embed(text: string): Promise<number[]> {
      assertSafeText(text);
      const embeddingModel = env('GEMINI_EMBEDDING_MODEL') || 'gemini-embedding-2';
      if (!/^gemini-embedding-[a-z0-9.-]+$/.test(embeddingModel)) throw new Error('AI_NOT_CONFIGURED');
      const response = await call(
        'embed',
        `https://generativelanguage.googleapis.com/v1beta/models/${embeddingModel}:embedContent`,
        {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(25000),
          body: JSON.stringify({ content: { parts: [{ text }] }, outputDimensionality: 768 }),
        },
      );
      const data = await responseJson(response, 50000);
      const values = data.embedding?.values;
      if (
        !Array.isArray(values) ||
        values.length !== 768 ||
        !values.every((x: unknown) => typeof x === 'number' && Number.isFinite(x))
      )
        throw new Error('PROVIDER_STREAM_INVALID');
      return values;
    },
  };
}
