import { z } from 'zod';
import { assertSafeText } from '../../../packages/harness-core/src/index.ts';
import type { Environment } from './runtime.ts';

const origin = 'https://openrouter.ai/api/v1';
const freeId = /^[a-zA-Z0-9_./-]+:free$/;
const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  pricing: z.record(z.string(), z.string()),
  architecture: z.object({ input_modalities: z.array(z.string()), output_modalities: z.array(z.string()) }),
});
const completionSchema = z.object({
  model: z.string(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.enum(['stop', 'length']),
      }),
    )
    .min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative().optional(),
  }),
});
export function trialConfigured(env: Environment, tenant: string) {
  return Boolean(env('OPENROUTER_API_KEY') && env('OPENROUTER_TRIAL_TENANT_ID') === tenant);
}
export function openrouter(env: Environment, fetcher: typeof fetch = fetch) {
  async function request(path: string, signal: AbortSignal, body?: unknown) {
    const key = env('OPENROUTER_API_KEY');
    if (!key) throw new Error('OPENROUTER_NOT_CONFIGURED');
    let response: Response;
    try {
      response = await fetcher(origin + path, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
        redirect: 'error',
      });
    } catch {
      throw new Error('OPENROUTER_UNAVAILABLE');
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('OPENROUTER_KEY_INVALID');
      if (response.status === 429) throw new Error('OPENROUTER_RATE_LIMIT');
      if (response.status === 402) throw new Error('OPENROUTER_CREDIT_REQUIRED');
      throw new Error('OPENROUTER_UNAVAILABLE');
    }
    try {
      return await response.json();
    } catch {
      throw new Error('OPENROUTER_RESPONSE_INVALID');
    }
  }
  async function models(signal = AbortSignal.timeout(8000)): Promise<{ id: string; name: string }[]> {
    const raw = await request('/models', signal);
    if (!Array.isArray(raw?.data)) throw new Error('OPENROUTER_RESPONSE_INVALID');
    return raw.data
      .flatMap((entry: unknown) => {
        const parsed = modelSchema.safeParse(entry);
        if (!parsed.success) return [];
        const model = parsed.data;
        const zero = (value: string | undefined) =>
          typeof value === 'string' && value.trim() !== '' && Number(value) === 0;
        if (
          !freeId.test(model.id) ||
          !zero(model.pricing.prompt) ||
          !zero(model.pricing.completion) ||
          !Object.values(model.pricing).every(zero) ||
          !model.architecture.input_modalities.includes('text') ||
          !model.architecture.output_modalities.includes('text')
        )
          return [];
        return [{ id: model.id, name: model.name }];
      })
      .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
  }
  return {
    models,
    async generate(model: string, prompt: string) {
      if (!freeId.test(model)) throw new Error('OPENROUTER_FREE_ONLY');
      assertSafeText(prompt);
      const started = Date.now(),
        signal = AbortSignal.timeout(20000);
      // Recheck the live catalog for every generation. Never trust a browser's price/model list.
      if (!(await models(signal)).some((item: { id: string }) => item.id === model))
        throw new Error('OPENROUTER_FREE_ONLY');
      const raw = await request('/chat/completions', signal, {
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        max_tokens: 2048,
        // Reasoning models can spend the whole output budget thinking. Keep it short and unreturned;
        // models without reasoning ignore this because require_parameters is not set here.
        reasoning: { effort: 'low', exclude: true },
        provider: { allow_fallbacks: false, max_price: { prompt: 0, completion: 0, request: 0, image: 0 } },
      });
      const parsed = completionSchema.safeParse(raw);
      if (!parsed.success || raw.error) throw new Error('OPENROUTER_RESPONSE_INVALID');
      const result = parsed.data,
        choice = result.choices[0],
        text = choice.message.content ?? '';
      if (!text.trim()) throw new Error('AI_EMPTY_REPLY');
      if (text.length > 20000) throw new Error('OPENROUTER_RESPONSE_INVALID');
      if (result.usage.cost !== undefined && result.usage.cost !== 0)
        throw new Error('OPENROUTER_COST_UNEXPECTED');
      return {
        model: result.model,
        text,
        inputTokens: result.usage.prompt_tokens,
        outputTokens: result.usage.completion_tokens,
        cost: result.usage.cost ?? null,
        truncated: choice.finish_reason === 'length',
        elapsedMs: Date.now() - started,
      };
    },
  };
}
