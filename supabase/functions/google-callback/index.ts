import { clients, environment, requireEnv, safeCode } from '../_shared/runtime.ts';
import { finishGoogle } from '../_shared/google.ts';
declare const Deno: { serve(handler: (request: Request) => Promise<Response>): void };
Deno.serve(async (request) => {
  let code = 'connected';
  try {
    await finishGoogle(request, clients(environment).service, environment);
  } catch (error) {
    code = safeCode(error);
  }
  const target = new URL('/settings', requireEnv(environment, 'APP_ORIGIN'));
  target.searchParams.set('google', code);
  return new Response(null, {
    status: 303,
    headers: { Location: target.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
});
