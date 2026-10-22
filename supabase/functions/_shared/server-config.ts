import { checked, clients, type Environment } from './runtime.ts';

const names = [
  'AI_PROVIDER',
  'OPENROUTER_API_KEY',
  'OPENROUTER_TRIAL_TENANT_ID',
  'OPENROUTER_MODEL',
  'OPENROUTER_PROVIDER',
  'WORKER_SECRET',
  'APP_ORIGIN',
] as const;
// Vault is an alternative server-only secret store. Environment values win.
// Never return the loaded map from an API response or log provider diagnostics.
export async function serverEnvironment(
  env: Environment,
  fetcher: typeof fetch = fetch,
): Promise<Environment> {
  const { service } = clients(env, undefined, fetcher);
  const stored = await checked<Record<string, unknown>>(service.rpc('read_server_runtime_config'));
  const safe: Record<string, string> = {};
  for (const name of names) {
    const value = stored?.[name];
    if (typeof value === 'string' && value.length > 0 && value.length <= 4000) safe[name] = value;
  }
  return (name) => env(name) || safe[name];
}
export function configUnavailable(_error: unknown) {
  return Response.json(
    { code: 'SERVER_NOT_CONFIGURED' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
