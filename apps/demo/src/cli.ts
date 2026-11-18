// Usage: pnpm demo   (needs ONCADE_API_KEY and ONCADE_BUSINESS_ID in .env; no LLM, no admin settings)
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { OncadeError } from '../../../packages/oncade-client/src/client';
import { runDemo } from './demo';

const ROOT = resolve(import.meta.dirname, '../../..');
const envFile = resolve(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile); // variables already set in the shell win

/** A TCP connect to 127.0.0.1:port, 1 s timeout. */
const receiverUp = (port: number) =>
  new Promise<boolean>((done) => {
    const s = connect({ host: '127.0.0.1', port, timeout: 1000 });
    s.once('connect', () => (s.destroy(), done(true)));
    s.once('timeout', () => (s.destroy(), done(false)));
    s.once('error', () => done(false));
  });

try {
  const code = await runDemo({
    env: process.env,
    // One run id per demo run: every write's Idempotency-Key is derived from it and the request,
    // so a retry inside this run cannot create a second invoice, and a new run makes new ones.
    runId: `demo-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    webhookLog: process.env.WEBHOOK_LOG || resolve(ROOT, 'data/webhooks.jsonl'),
    out: (line) => console.log(line),
    receiverUp,
  });
  process.exit(code);
} catch (e) {
  console.error(e instanceof OncadeError ? `Oncade API error: ${e.message}` : e);
  if (e instanceof OncadeError && JSON.stringify(e.body).includes('SCOPE_NOT_GRANTED'))
    console.error('The key lacks invoice scopes: a business admin must approve them (see README, Oncade issues).');
  process.exit(1);
}
