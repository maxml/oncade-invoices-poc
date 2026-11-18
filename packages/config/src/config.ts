/**
 * The whole environment of this repo, validated once with Zod. Every entry point (server, `pnpm
 * ask`, `pnpm eval`, the MCP server) and `runAgent` read settings from here, never from
 * `process.env` directly, so a bad value fails at start-up with a message naming the variable.
 *
 * Empty values (`KEY=` in .env) count as unset.
 */
import { z } from 'zod';

const unsetIfEmpty = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optional = () => z.preprocess(unsetIfEmpty, z.string().optional());
const withDefault = <T extends z.ZodType>(schema: T) => z.preprocess(unsetIfEmpty, schema);
const port = (def: number) => withDefault(z.coerce.number().int().min(1).max(65535).default(def));

export const ConfigSchema = z
  .object({
    // Oncade (test environment only)
    ONCADE_API_KEY: z.preprocess(
      unsetIfEmpty,
      z
        .string({ error: 'is required (an Oncade test platform key, see .env.example)' })
        .startsWith('oncade_platform_test_', 'must be an Oncade TEST platform key (oncade_platform_test_...)'),
    ),
    ONCADE_BUSINESS_ID: z.preprocess(unsetIfEmpty, z.string({ error: 'is required (shown in the developer portal)' })),
    ONCADE_WEBHOOK_SECRET: optional(),

    // Agent
    ANTHROPIC_API_KEY: optional(),
    AGENT_MODEL: withDefault(z.string().default('sonnet')),
    AGENT_SANDBOX: withDefault(z.enum(['auto', 'on', 'off']).default('auto')),
    AGENT_TIMEOUT_MS: withDefault(z.coerce.number().int().min(1000).default(180_000)),
    AGENT_MAX_TURNS: withDefault(z.coerce.number().int().min(1).max(50).default(12)),
    AGENT_MAX_BUDGET_USD: withDefault(z.coerce.number().positive().default(0.5)),
    AGENT_DAILY_BUDGET_USD: withDefault(z.coerce.number().min(0).default(2)),
    EVAL_BUDGET_USD: withDefault(z.coerce.number().positive().default(1)),

    // Web app (the security policy for these is securityConfig() in apps/server/src/env.ts)
    ADMIN_USER: withDefault(z.string().default('admin')),
    ADMIN_PASSWORD: optional(),
    SESSION_SECRET: optional(),
    ALLOW_INSECURE_DEFAULTS: optional(),
    PORT: port(3000),
    WEBHOOK_PORT: port(3001),

    // Files (defaults are under data/, resolved by the caller)
    RUNS_LOG: optional(),
    WEBHOOK_LOG: optional(),
    LINK_SESSION_CACHE: optional(),

    // Set by runAgent for the MCP server it starts; not for .env.
    ONCADE_READ_ONLY: optional(),
    ONCADE_RUN_ID: optional(),
    ONCADE_ALLOWED_INVOICES: optional(),
    ONCADE_ALLOWED_EMAILS: optional(),
    ONCADE_EMAIL_ALLOWED: optional(),
  })
  .refine((c) => c.PORT !== c.WEBHOOK_PORT, {
    path: ['WEBHOOK_PORT'],
    message: 'must differ from PORT (the UI and the webhook receiver listen on separate ports)',
  });

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration (see .env.example):\n${problems.map((p) => `- ${p}`).join('\n')}`);
  }
}

/** Parse and validate; throws ConfigError listing every bad variable by name. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const r = ConfigSchema.safeParse(env);
  if (r.success) return r.data;
  throw new ConfigError(r.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`));
}
