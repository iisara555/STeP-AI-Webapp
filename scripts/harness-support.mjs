import { readdir, readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';

/** Only non-executable text inside this registered Skill. No links into another Skill or private directory. */
export async function skillSupport(root, skillDirectory, deniedPaths = new Set()) {
  root = await realpath(root);
  const base = await realpath(resolve(root, skillDirectory));
  const inside = relative(root, base);
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('SUPPORT_OUTSIDE_ROOT');
  const result = [];
  async function walk(path, depth) {
    const target = await realpath(path);
    const child = relative(base, target);
    if (child.startsWith('..') || isAbsolute(child)) throw new Error('SUPPORT_OUTSIDE_SKILL');
    if (depth > 5) throw new Error('SUPPORT_DEPTH');
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('SUPPORT_SYMLINK');
      const file = resolve(target, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (
        entry.isFile() &&
        ['.md', '.txt', '.yaml', '.yml', '.json', '.csv'].includes(extname(entry.name))
      ) {
        const path = relative(root, file).replaceAll('\\', '/');
        if (deniedPaths.has(path)) continue;
        const body = await readFile(file, 'utf8');
        if (body.length > 200000) throw new Error('SOURCE_TOO_LARGE');
        if (/\b(?:sk-|ghp_|github_pat_|AIza)[A-Za-z0-9_-]{24,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(body))
          throw new Error('SECRET_DETECTED');
        result.push({ path, body });
        if (result.length > 150) throw new Error('SUPPORT_LIMIT');
      }
    }
  }
  for (const folder of ['references', 'templates', 'examples']) {
    try {
      await walk(resolve(base, folder), 0);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
