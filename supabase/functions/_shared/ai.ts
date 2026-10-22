import type { AiService } from '../../../packages/harness-core/src/contracts.ts';
import { freeModelConfig, openrouterFree } from './openrouter-free.ts';
import { gemini } from './gemini.ts';
import type { Environment } from './runtime.ts';

export function aiService(env: Environment): AiService {
  const provider = env('AI_PROVIDER') || 'gemini';
  if (provider === 'openrouter_free') {
    let model = '',
      upstream = '',
      valid = true;
    try {
      ({ model, upstream } = freeModelConfig(env));
    } catch {
      valid = false;
    }
    return {
      provider,
      model,
      upstream,
      displayName: model ? `OpenRouter · ${upstream} · ${model}` : 'OpenRouter · รุ่นฟรีสำหรับทดลอง',
      consentId: JSON.stringify([provider, model, upstream, 'data_collection=deny', 'text-only']),
      configured: Boolean(valid && env('OPENROUTER_API_KEY') && env('WORKER_SECRET')),
      textOnly: true,
    };
  }
  const model = env('GEMINI_MODEL') || 'gemini-3.8-flash';
  return {
    provider: 'gemini',
    model,
    upstream: 'google',
    displayName: `Google Gemini API · ${model}`,
    consentId: JSON.stringify(['gemini', model, env('GEMINI_EMBEDDING_MODEL') || 'gemini-embedding-2']),
    configured: Boolean(
      provider === 'gemini' &&
      /^gemini-[a-z0-9.-]+$/.test(model) &&
      env('GEMINI_API_KEY') &&
      env('WORKER_SECRET'),
    ),
    textOnly: false,
  };
}
export function modelClient(env: Environment, fetcher: typeof fetch = fetch) {
  const info = aiService(env);
  if (!info.configured) throw new Error('AI_NOT_CONFIGURED');
  return info.provider === 'openrouter_free' ? openrouterFree(env, fetcher) : gemini(env, fetcher);
}
export function requireProviderConsent(env: Environment, consentId: string) {
  const info = aiService(env);
  if (consentId !== info.consentId) throw new Error('AI_PROVIDER_CHANGED');
  return info;
}
