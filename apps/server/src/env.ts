import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Load ./.env (Node 24 built-in) and fail fast on what the app cannot run without. */
export function loadEnv() {
  const file = resolve(import.meta.dirname, '../../../.env');
  if (existsSync(file)) process.loadEnvFile(file);
  const missing = ['ONCADE_API_KEY', 'ONCADE_BUSINESS_ID'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing in .env: ${missing.join(', ')} (see .env.example)`);
  process.env.WEBHOOK_LOG ??= resolve(import.meta.dirname, '../../../data/webhooks.jsonl');
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
