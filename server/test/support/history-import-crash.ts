// Child for the history-import crash test: imports a synthetic batch and SIGKILLs itself inside the transaction of
// conversation `crashAt`, after its rows were written and before commit.
import { importHistory } from '../../src/workspace/history-import.ts';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { root, workspaceId, owner, batch, key, crashAt } = JSON.parse(input);
await importHistory({
  dataRoot: root,
  owner,
  workspaceId,
  mappings: batch.mappings,
  conversations: batch.conversations,
  digestKey: Buffer.from(key, 'hex'),
  fault: (position) => {
    if (position === crashAt) process.kill(process.pid, 'SIGKILL');
  },
});
process.exit(3); // never reached when the crash point is hit
