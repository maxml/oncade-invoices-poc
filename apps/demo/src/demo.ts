/**
 * `pnpm demo`: the invoice flow against the Oncade test API, no LLM. Creates a $1 draft and sends
 * it (no email), creates a second draft and cancels it, reads both back, then waits for the
 * matching webhooks when the receiver is set up. Every dependency is injected for the tests.
 */
import { existsSync, readFileSync } from 'node:fs';
import { ConfigError, parseOncadeConfig } from '../../../packages/config/src/config';
import { createOncadeClient, OncadeError } from '../../../packages/oncade-client/src/client';

export interface DemoDeps {
  env: Record<string, string | undefined>;
  runId: string;
  webhookLog: string;
  out: (line: string) => void;
  fetch?: typeof fetch;
  /** True when something listens on 127.0.0.1:port (the webhook receiver from `pnpm dev`). */
  receiverUp: (port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
}

type Invoice = { _id?: string; invoiceNumber?: string; status?: string; invoice?: Invoice };
const show = (x: unknown) => {
  const i = ((x as Invoice)?.invoice ?? x) as Invoice;
  return { id: String(i?._id ?? '?'), text: `id=${i?._id ?? '?'} number=${i?.invoiceNumber ?? '?'} status=${i?.status ?? '?'}` };
};

export async function runDemo(d: DemoDeps): Promise<number> {
  let cfg;
  try {
    cfg = parseOncadeConfig(d.env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    d.out(e.message);
    d.out('The demo needs only ONCADE_API_KEY (oncade_platform_test_...) and ONCADE_BUSINESS_ID in .env.');
    d.out('Start with: cp .env.example .env   (or run ./scripts/doctor.sh)');
    d.out('Demo FAILED: required settings are missing.');
    return 1;
  }
  const client = createOncadeClient({
    apiKey: cfg.ONCADE_API_KEY,
    businessId: cfg.ONCADE_BUSINESS_ID,
    runId: d.runId,
    fetch: d.fetch,
  });
  const today = new Date().toISOString().slice(0, 10);
  const draft = (label: string) => ({
    receiverName: `Oncade demo (${label})`,
    receiverEmail: 'demo@example.com',
    date: today,
    items: [{ description: `Demo item, ${label}`, quantity: 1, rate: 1 }],
    externalMetadata: { demoRunId: d.runId },
  });

  const create = async (label: string) => {
    const r = show(await client.createDraftInvoice(draft(label)));
    if (r.id === '?') throw new Error(`Oncade created a draft but returned no _id: ${r.text}`);
    return r;
  };

  d.out(`Oncade invoices demo, run ${d.runId} (test environment)`);
  let a, b;
  try {
    a = await create('to send');
    d.out(`1. Created draft A:      ${a.text}`);
    d.out(`2. Sent A (no email):    ${show(await client.sendInvoice(a.id, false)).text}`);
    b = await create('to cancel');
    d.out(`3. Created draft B:      ${b.text}`);
    d.out(`4. Cancelled B:          ${show(await client.cancelInvoice(b.id)).text}`);
    d.out(`5. GET A:                ${show(await client.getInvoice(a.id)).text}`);
    d.out(`   GET B:                ${show(await client.getInvoice(b.id)).text}`);
  } catch (e) {
    if (!(e instanceof OncadeError)) throw e;
    d.out(`Demo FAILED: Oncade API error: ${e.message}`);
    if (JSON.stringify(e.body).includes('SCOPE_NOT_GRANTED'))
      d.out('The key lacks invoice scopes: a business admin must approve them (see README, Oncade issues).');
    return 1;
  }

  const FINISHED = 'Demo finished: the invoice flow worked (draft, send, cancel, read back).';
  const port = cfg.WEBHOOK_PORT;
  if (!cfg.ONCADE_WEBHOOK_SECRET || !(await d.receiverUp(port))) {
    d.out(
      `6. Webhooks (optional): not checked, ${cfg.ONCADE_WEBHOOK_SECRET ? `no receiver running on 127.0.0.1:${port}` : 'ONCADE_WEBHOOK_SECRET is not set'}.`,
    );
    d.out('');
    d.out(FINISHED);
    d.out('');
    d.out('Optional, to see the webhooks too: run `pnpm dev` (receiver on WEBHOOK_PORT) and `pnpm tunnel`');
    d.out('(ngrok), set the webhook URL https://<ngrok-host>/webhooks/oncade in dev.oncade.xyz Platform');
    d.out('Settings, put its secret in ONCADE_WEBHOOK_SECRET in .env, restart `pnpm dev`, then run');
    d.out('`pnpm demo` again.');
    return 0;
  }

  const wanted = [
    `Platform.Invoice.Created ${a.id}`,
    `Platform.Invoice.Sent ${a.id}`,
    `Platform.Invoice.Created ${b.id}`,
    `Platform.Invoice.Cancelled ${b.id}`,
  ];
  const waitMs = d.waitMs ?? 60_000;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  d.out(`6. Waiting up to ${waitMs / 1000} s for ${wanted.length} webhooks in ${d.webhookLog} ...`);
  const seen = new Set<string>();
  for (let waited = 0; ; waited += 1000) {
    for (const ev of readEvents(d.webhookLog)) {
      const key = `${ev.event} ${ev.data?.invoiceId}`;
      if (wanted.includes(key) && !seen.has(key)) {
        seen.add(key);
        d.out(`   received ${key} (status=${ev.data?.status ?? '?'}, at ${ev.receivedAt ?? '?'})`);
      }
    }
    if (seen.size === wanted.length) {
      d.out('   all four webhooks arrived and were verified by the receiver.');
      d.out('');
      d.out(FINISHED);
      return 0;
    }
    if (waited >= waitMs) break;
    await sleep(1000);
  }
  d.out(`   Webhooks timed out after ${waitMs / 1000} s; missing: ${wanted.filter((w) => !seen.has(w)).join(', ')}.`);
  d.out('');
  d.out(`Demo FAILED: the invoice flow worked, but the webhooks did not arrive within ${waitMs / 1000} s.`);
  d.out('Check that `pnpm tunnel` is up, that the webhook URL in Platform Settings is the current ngrok host');
  d.out('+ /webhooks/oncade, and that `pnpm dev` logs no "bad signature" (wrong secret).');
  return 1;
}

type StoredEvent = { event?: string; receivedAt?: string; data?: { invoiceId?: string; status?: string } };
function readEvents(file: string): StoredEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l) as StoredEvent] : [];
      } catch {
        return [];
      }
    });
}
