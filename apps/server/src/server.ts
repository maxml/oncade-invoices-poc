/** Entry point: load .env, refuse insecure defaults, start the app on 127.0.0.1. */
import { loadEnv, securityConfig } from './env';
import { buildApp } from './app';
import { WebhookStore } from './webhook-store';
import { runAgent } from '../../agent/src/run-agent';

loadEnv();
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
      `!! Local demo only. Do not expose this server (no tunnel) in this mode.\n${bar}\n`,
  );
}

const app = await buildApp({
  security,
  runAgent,
  webhookSecret: process.env.ONCADE_WEBHOOK_SECRET ?? '',
  webhookStore: new WebhookStore(process.env.WEBHOOK_LOG!),
  logger: true,
});
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '127.0.0.1' });
