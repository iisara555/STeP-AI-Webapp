import { LIMITS, assertSafeText, estimateTextTokens } from '../../../packages/harness-core/src/index.ts';
import { responseJson, type GenerateInput, type ModelResult } from './gemini.ts';
import type { Environment } from './runtime.ts';

// No router, fallback model, plugins, embeddings or paid endpoint is permitted.
export function freeModelConfig(env: Environment) {
  const model = env('OPENROUTER_MODEL') || '';
  const upstream = env('OPENROUTER_PROVIDER') || '';
  if (!/^[a-z0-9._-]+\/[a-z0-9._-]+:free$/.test(model) || !/^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/.test(upstream))
    throw new Error('AI_NOT_CONFIGURED');
  return { model, upstream };
}

function providerError(status: number): never {
  if (status === 429) throw new Error('AI_FREE_RATE_LIMIT');
  if (status === 401) throw new Error('AI_NOT_CONFIGURED');
  if ([402, 403, 404, 503].includes(status)) throw new Error('AI_FREE_UNAVAILABLE');
  throw new Error('AI_SERVICE_ERROR');
}

export function openrouterFree(env: Environment, fetcher: typeof fetch = fetch) {
  const { model, upstream } = freeModelConfig(env);
  const key = env('OPENROUTER_API_KEY');
  if (!key) throw new Error('AI_NOT_CONFIGURED');
  return {
    async generate(input: GenerateInput): Promise<ModelResult> {
      // This pilot is text-only. Reject before reading or uploading any image.
      if (input.image || input.json) throw new Error('AI_TRIAL_TEXT_ONLY');
      assertSafeText(input.prompt);
      assertSafeText(input.system);
      const estimated = estimateTextTokens(input.system + '\n' + input.prompt).estimatedTokens;
      if (estimated > LIMITS.contextTokens) throw new Error('CONTEXT_TOO_LARGE');
      const signal = input.signal || AbortSignal.timeout(80000);
      const catalogue = await fetcher('https://openrouter.ai/api/v1/models', { signal });
      if (!catalogue.ok) providerError(catalogue.status);
      const data = await responseJson(catalogue, 5000000);
      const selected = Array.isArray(data.data)
        ? data.data.find((m: { id?: string }) => m.id === model)
        : null;
      const price = selected?.pricing;
      if (
        !price ||
        !Object.hasOwn(price, 'prompt') ||
        !Object.hasOwn(price, 'completion') ||
        !Object.values(price).every(
          (p) =>
            (typeof p === 'string' || typeof p === 'number') && String(p).trim() !== '' && Number(p) === 0,
        ) ||
        !selected.architecture?.input_modalities?.includes('text') ||
        !selected.architecture?.output_modalities?.includes('text')
      )
        throw new Error('AI_FREE_UNAVAILABLE');
      const contextLimit = selected.top_provider?.context_length || selected.context_length;
      if (!Number.isSafeInteger(contextLimit) || estimated + LIMITS.outputTokens > contextLimit)
        throw new Error('CONTEXT_TOO_LARGE');
      const response = await fetcher('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.prompt },
          ],
          max_tokens: LIMITS.outputTokens,
          stream: false,
          provider: {
            only: [upstream],
            allow_fallbacks: false,
            require_parameters: true,
            data_collection: 'deny',
            max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
          },
        }),
      });
      if (!response.ok) providerError(response.status);
      const answer = await responseJson(response);
      if (answer.error) providerError(Number(answer.error.code));
      const choice = answer.choices?.[0];
      const text = choice?.message?.content;
      const usage = answer.usage;
      if (
        !['stop', 'length'].includes(choice?.finish_reason) ||
        choice.message?.tool_calls?.length ||
        typeof text !== 'string' ||
        !text.trim() ||
        text.length > 200000 ||
        !Number.isSafeInteger(usage?.prompt_tokens) ||
        usage.prompt_tokens < 0 ||
        !Number.isSafeInteger(usage?.completion_tokens) ||
        usage.completion_tokens < 0 ||
        (usage.cost != null && Number(usage.cost) !== 0)
      )
        throw new Error('PROVIDER_STREAM_INVALID');
      assertSafeText(text);
      return {
        text,
        truncated: choice.finish_reason === 'length',
        usage: { input: usage.prompt_tokens, output: usage.completion_tokens },
      };
    },
    async embed(_text: string): Promise<number[]> {
      throw new Error('AI_TRIAL_TEXT_ONLY');
    },
  };
}
