import { createApi } from '../_shared/api.ts';
import { environment, requireEnv } from '../_shared/runtime.ts';
import { configUnavailable, serverEnvironment } from '../_shared/server-config.ts';
declare const Deno: { serve(handler: (request: Request) => Promise<Response>): void };
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };
Deno.serve(async (request) => {
  try {
    const configured = await serverEnvironment(environment);
    return await createApi(configured, {
      kick: async () => {
        const pending = fetch(requireEnv(configured, 'SUPABASE_URL') + '/functions/v1/worker', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + requireEnv(configured, 'WORKER_SECRET') },
          signal: AbortSignal.timeout(110000),
        });
        EdgeRuntime.waitUntil(pending);
      },
    })(request);
  } catch (error) {
    return configUnavailable(error);
  }
});
