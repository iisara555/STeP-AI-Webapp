// ADR 0001: the engine submodule may only point at a published Desktop release (a desktop-v* tag of Harness).
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const [mode, pinned] = git('ls-files', '--stage', 'harness').split(/\s+/);
if (mode !== '160000') throw new Error('harness is not a submodule');
const url = git('config', '-f', '.gitmodules', 'submodule.harness.url');
const tags = git('ls-remote', '--tags', url, 'refs/tags/desktop-v*')
  .split('\n')
  .map((line) => line.split('\t'))
  .filter(([sha]) => sha === pinned)
  .map(([, ref]) => ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, ''));
if (!tags.length) {
  console.error(`harness is pinned to ${pinned}, which is not a desktop-v* release tag of ${url}`);
  process.exit(1);
}
console.log(`harness pinned to ${[...new Set(tags)].join(', ')} (${pinned.slice(0, 7)})`);
