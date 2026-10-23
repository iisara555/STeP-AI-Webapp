import { createWorker } from '../_shared/worker.ts';
import { environment } from '../_shared/runtime.ts';
import { configUnavailable, serverEnvironment } from '../_shared/server-config.ts';
declare const Deno: { serve(handler: (request: Request) => Promise<Response>): void };
Deno.serve(async (request) => {
  try {
    return await createWorker(await serverEnvironment(environment))(request);
  } catch (error) {
    return configUnavailable(error);
  }
});
