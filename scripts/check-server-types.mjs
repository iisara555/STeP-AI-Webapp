// Type-checks the server's own code strictly. The pinned engine (harness/) is type-checked by Desktop's CI with
// its full dependency set; here it lacks packages the server never installs, so only diagnostics in harness/ are
// left out. Any diagnostic in server/ fails the check.
import { spawnSync } from 'node:child_process';

const tsc = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false', '-p', 'server'], { encoding: 'utf8' });
const lines = (tsc.stdout + tsc.stderr).split('\n').filter((line) => /error TS\d+/.test(line));
const own = lines.filter((line) => !line.startsWith('harness/'));
for (const line of own) console.error(line);
if (own.length || (tsc.status !== 0 && !lines.length)) process.exit(1);
console.log(`server types ok (${lines.length} engine diagnostics left to Desktop CI)`);
