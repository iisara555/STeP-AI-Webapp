import { clients, environment, requireEnv, safeCode } from '../_shared/runtime.ts';
import { finishGoogle } from '../_shared/google.ts';
import { configUnavailable, serverEnvironment } from '../_shared/server-config.ts';
declare const Deno: { serve(handler: (request: Request) => Promise<Response>): void };
Deno.serve(async (request) => {
  let configured;
  try {
    configured = await serverEnvironment(environment);
  } catch (error) {
    return configUnavailable(error);
  }
  let code = 'connected';
  try {
    await finishGoogle(request, clients(configured).service, configured);
  } catch (error) {
    code = safeCode(error);
  }
  const target = new URL('/settings', requireEnv(configured, 'APP_ORIGIN'));
  target.searchParams.set('google', code);
  return new Response(null, {
    status: 303,
    headers: { Location: target.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
});
