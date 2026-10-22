import { createWorker } from '../_shared/worker.ts';
import { environment } from '../_shared/runtime.ts';
declare const Deno: { serve(handler: (request: Request) => Promise<Response>): void };
Deno.serve(createWorker(environment));
