// Entry of one Workspace runtime process (process driver). Phase 1 only proves the lifecycle: it checks that it
// was started inside its own Workspace folder and answers health. Phase 2 opens the headless engine here with
// <dir>/workspace.sqlite (see ../engine.ts).
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';

const workspaceId = process.env.STEP_WORKSPACE_ID;
const dir = process.env.STEP_WORKSPACE_DIR;
const started = Date.now();
const send = process.send?.bind(process);

if (!send || !workspaceId || !dir || process.cwd() !== join(dir, 'files')) process.exit(2);
await access(dir, constants.R_OK | constants.W_OK);

process.on('message', (message: { type: string; nonce?: number }) => {
  if (message.type === 'health')
    send!({
      type: 'health',
      nonce: message.nonce,
      ok: true,
      workspaceId,
      pid: process.pid,
      uptimeMs: Date.now() - started,
      cwd: process.cwd(),
    });
  if (message.type === 'stop') process.disconnect?.();
});
// The manager going away is the same as a stop: no runtime outlives its supervisor.
process.on('disconnect', () => process.exit(0));
send!({ type: 'ready' });
