/**
 * Entry point: load and validate .env, refuse insecure defaults, then start two listeners on
 * 127.0.0.1: the UI on PORT (never tunnelled) and the webhook receiver on WEBHOOK_PORT (the only
 * port `pnpm tunnel` exposes).
 */
import { spawnSync } from 'node:child_process';
import { loadEnv, securityConfig } from './env';
import { buildUiApp, buildWebhookApp, listenBoth } from './app';
import { WebhookStore } from './webhook-store';
import { runAgent } from '../../agent/src/run-agent';
import { createOncadeClient } from '../../../packages/oncade-client/src/client';

const config = loadEnv();
let security;
try {
  security = securityConfig(process.env);
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
}
if (security.insecureDefaults) {
  const bar = '!'.repeat(78);
  console.warn(
    `\n${bar}\n!! ALLOW_INSECURE_DEFAULTS=1: default admin password and/or session secret in use.\n` +
      `!! Local demo only.\n${bar}\n`,
  );
}

// Health check client: one attempt, short timeout, so /healthz answers fast when Oncade is down.
const healthClient = createOncadeClient({
  apiKey: config.ONCADE_API_KEY,
  businessId: config.ONCADE_BUSINESS_ID,
  timeoutMs: 2_500,
  maxAttempts: 1,
});

const ui = await buildUiApp({
  security,
  runAgent,
  health: {
    oncade: () => healthClient.me(),
    claude: () => {
      const r = spawnSync('which', ['claude'], { encoding: 'utf8' });
      return r.status === 0 ? r.stdout.trim() : null;
    },
  },
  logger: true,
});
const webhooks = await buildWebhookApp({
  webhookSecret: config.ONCADE_WEBHOOK_SECRET ?? '',
  webhookStore: new WebhookStore(process.env.WEBHOOK_LOG!),
  logger: true,
});
if (!config.ONCADE_WEBHOOK_SECRET) console.warn('[webhooks] ONCADE_WEBHOOK_SECRET is not set: every webhook will get 401');

await listenBoth(ui, webhooks, { ui: config.PORT, webhook: config.WEBHOOK_PORT });
