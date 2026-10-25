// Load with `node --import ./server/src/register.mjs`. The engine's providers.ts imports the Copilot SDK statically;
// Copilot is off on the server (ADR 0001, item 5), so its native client is replaced by a module that refuses to start.
import { register } from 'node:module';

register('./resolve-hooks.mjs', import.meta.url);
