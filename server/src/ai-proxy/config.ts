// The organization AI gateway's settings file (models staff may use, spending caps, departments). It holds no key:
// the OpenRouter key comes from the environment or a 0600 file. The file is read again whenever it changes, so an
// administrator can raise a cap or move someone to another department without a restart.
import { stat, readFile } from 'node:fs/promises';
import { z } from 'zod';

const Email = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[^\s@]+@[^\s@]+$/);
/** US dollars; OpenRouter bills in USD. */
const Usd = z.number().nonnegative().max(100_000);

const Model = z
  .object({
    /** The name staff and Desktop see (e.g. step-chat). The upstream model can change without touching Desktop. */
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
    label: z.string().trim().min(1).max(120),
    /** OpenRouter model id, e.g. anthropic/claude-haiku-5.5. */
    upstream: z
      .string()
      .max(160)
      .regex(/^[a-z0-9~][a-z0-9._-]*\/[a-z0-9._:-]+$/i),
    /** USD per million tokens; used only when OpenRouter reports no cost for a request. */
    price: z.object({ input: Usd, output: Usd }).strict(),
    maxOutputTokens: z.number().int().min(256).max(128_000).default(8192),
    default: z.boolean().optional(),
  })
  .strict();

const Department = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/),
    name: z.string().trim().min(1).max(120),
    monthlyUsd: Usd,
    /** Overrides budget.userMonthlyUsd for this department's members. */
    userMonthlyUsd: Usd.optional(),
    members: z.array(Email).max(2_000),
  })
  .strict();

export const AiGatewayConfig = z
  .object({
    models: z.array(Model).min(1).max(20),
    /** OpenRouter provider slugs allowed to serve requests (e.g. google-vertex, amazon-bedrock); empty = any ZDR one. */
    providers: z
      .array(z.string().regex(/^[a-z0-9-]{1,60}$/))
      .max(30)
      .optional(),
    budget: z
      .object({
        /** The whole organization's monthly cap; keep it a little under the OpenRouter key's own limit. */
        orgMonthlyUsd: Usd,
        userMonthlyUsd: Usd,
        /** Requests one person may have in flight (Desktop runs a few small checks beside the answer). */
        userConcurrency: z.number().int().min(1).max(10).default(3),
        /** Only for showing baht in reports. */
        thbPerUsd: z.number().positive().max(1_000).optional(),
      })
      .strict(),
    departments: z.array(Department).max(100).default([]),
  })
  .strict()
  .superRefine((config, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (new Set(config.models.map((m) => m.id)).size !== config.models.length)
      issue('model ids must be unique');
    if (config.models.filter((m) => m.default).length > 1) issue('at most one default model');
    if (new Set(config.departments.map((d) => d.id)).size !== config.departments.length)
      issue('department ids must be unique');
    const members = config.departments.flatMap((d) => d.members);
    if (new Set(members).size !== members.length) issue('a person belongs to at most one department');
  });
export type AiGatewayConfig = z.infer<typeof AiGatewayConfig>;
export type AiModel = AiGatewayConfig['models'][number];

/** Staff not listed under a department are counted here, under the organization-wide per-person cap. */
export const UNASSIGNED = { id: 'unassigned', name: 'ไม่ระบุหน่วยงาน' } as const;

export function departmentOf(config: AiGatewayConfig, email: string) {
  return config.departments.find((d) => d.members.includes(email.toLowerCase()));
}

export function userCapUsd(config: AiGatewayConfig, email: string) {
  return departmentOf(config, email)?.userMonthlyUsd ?? config.budget.userMonthlyUsd;
}

export function defaultModel(config: AiGatewayConfig) {
  return config.models.find((m) => m.default) ?? config.models[0];
}

/**
 * Reads the settings file again when its modification time changes. An invalid file fails closed (every AI request
 * is refused with AI_CONFIG_INVALID) rather than falling back to looser limits.
 */
export function configFile(path: string) {
  let cached: { mtimeMs: number; size: number; config: AiGatewayConfig } | undefined;
  return async (): Promise<AiGatewayConfig> => {
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new Error('AI_CONFIG_INVALID');
    }
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.config;
    try {
      const config = AiGatewayConfig.parse(JSON.parse(await readFile(path, 'utf8')));
      cached = { mtimeMs: info.mtimeMs, size: info.size, config };
      return config;
    } catch {
      cached = undefined;
      throw new Error('AI_CONFIG_INVALID');
    }
  };
}
