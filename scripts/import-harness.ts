import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { operator } from './operator.ts';
import { assertSafeText } from '../packages/harness-core/src/index.ts';
const { values } = parseArgs({ options: { file: { type: 'string' }, tenant: { type: 'string' } } });
if (!values.file || !values.tenant) throw new Error('Use --file private-pack.json --tenant UUID');
const body = await readFile(values.file, 'utf8');
if (Buffer.byteLength(body) > 20 * 1024 * 1024) throw new Error('PACK_TOO_LARGE');
assertSafeText(body);
const key = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_-]+$/);
const pack = z
  .object({
    format: z.literal('step-harness-pack/v1'),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    sources: z
      .array(
        z.object({
          source_key: key,
          title: z.string().max(500),
          body: z.string().max(200000),
          source_version: z.string().max(100),
          provenance: z.record(z.string(), z.unknown()),
        }),
      )
      .max(500),
    skills: z
      .array(
        z.object({
          skill_key: key,
          title: z.string().max(200),
          description: z.string().max(600),
          instructions: z.string().max(60000),
          metadata: z.record(z.string(), z.unknown()),
          source_version: z.string().max(100),
        }),
      )
      .max(200),
  })
  .parse(JSON.parse(body));
for (const required of ['__authority', '__organization'])
  if (!pack.sources.some((s) => s.source_key === required)) throw new Error('HARNESS_INCOMPLETE');
const { error } = await operator().rpc('import_harness_pack', { t: z.uuid().parse(values.tenant), pack });
if (error) throw new Error('IMPORT_FAILED');
console.log(
  JSON.stringify({
    sourceCommit: pack.sourceCommit,
    documents: pack.sources.length,
    skills: pack.skills.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  }),
);
