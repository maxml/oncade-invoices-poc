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
