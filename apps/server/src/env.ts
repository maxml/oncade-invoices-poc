import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError, parseConfig, type Config } from '../../../packages/config/src/config';

const ROOT = resolve(import.meta.dirname, '../../..');

/**
 * Load ./.env (Node 24 built-in; variables already set in the shell win) and validate the whole
 * environment with Zod. On a bad value: print which variable is wrong and exit 1.
 */
export function loadEnv(): Config {
  const file = resolve(ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
  // The MCP server inside the sandbox gets this path from runAgent, so it must be absolute.
  process.env.WEBHOOK_LOG ||= resolve(ROOT, 'data/webhooks.jsonl');
  try {
    return parseConfig(process.env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}

/** Values that shipped in this repo or are obvious guesses. */
const DEFAULT_PASSWORDS = new Set(['', 'admin', 'password', 'changeme', 'change-me']);
const DEFAULT_SECRETS = new Set(['', 'change-me', 'changeme', 'dev-only-change-me', 'secret']);
const INSECURE_DEMO_SESSION_SECRET = 'dev-only-change-me-insecure-demo-secret';

export interface SecurityConfig {
  adminUser: string;
  adminPassword: string;
  sessionSecret: string;
  insecureDefaults: boolean;
}

/**
 * The only way the server gets its login password and cookie secret. Refuses default or weak
 * values unless ALLOW_INSECURE_DEFAULTS=1 is set explicitly (local demos), in which case the
 * defaults are used and `insecureDefaults` is true so the caller can warn loudly.
 */
export function securityConfig(env: NodeJS.ProcessEnv): SecurityConfig {
  const adminUser = env.ADMIN_USER || 'admin';
  const adminPassword = env.ADMIN_PASSWORD ?? '';
  const sessionSecret = env.SESSION_SECRET ?? '';
  const problems: string[] = [];
  if (DEFAULT_PASSWORDS.has(adminPassword) || adminPassword.length < 12)
    problems.push('ADMIN_PASSWORD must be set to a non-default value of at least 12 characters');
  if (DEFAULT_SECRETS.has(sessionSecret) || sessionSecret.length < 32)
    problems.push('SESSION_SECRET must be set to a random value of at least 32 characters (openssl rand -hex 32)');
  if (!problems.length) return { adminUser, adminPassword, sessionSecret, insecureDefaults: false };
  if (env.ALLOW_INSECURE_DEFAULTS === '1') {
    return {
      adminUser,
      adminPassword: adminPassword || 'admin',
      sessionSecret: sessionSecret.length >= 32 ? sessionSecret : INSECURE_DEMO_SESSION_SECRET,
      insecureDefaults: true,
    };
  }
  throw new Error(
    `Refusing to start:\n- ${problems.join('\n- ')}\nSet them in .env, or run a local-only demo with ALLOW_INSECURE_DEFAULTS=1.`,
  );
}
