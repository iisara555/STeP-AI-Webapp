import { createApi } from '../_shared/api.ts';
import { environment, requireEnv } from '../_shared/runtime.ts';
declare const Deno: { serve(handler: (request: Request) => Promise<Response>): void };
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };
Deno.serve(
  createApi(environment, {
    kick: async () => {
      const pending = fetch(requireEnv(environment, 'SUPABASE_URL') + '/functions/v1/worker', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + requireEnv(environment, 'WORKER_SECRET') },
        signal: AbortSignal.timeout(110000),
      });
      EdgeRuntime.waitUntil(pending);
    },
  }),
);
