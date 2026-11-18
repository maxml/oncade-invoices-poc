import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDemo, type DemoDeps } from './demo';

const ENV = { ONCADE_API_KEY: 'oncade_platform_test_fake', ONCADE_BUSINESS_ID: 'biz_1' };

type Call = { method: string; path: string; headers: Record<string, string>; body: any };

/** An in-memory Oncade: create / send / cancel / get, ids inv_1, inv_2, ... */
function fakeOncade() {
  const calls: Call[] = [];
  const invoices = new Map<string, any>();
  const fakeFetch = (async (url: string, init: any) => {
    const path = url.replace('https://www.oncade.gg/api/v1/platform', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, headers: init.headers, body });
    const reply = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (init.method === 'POST' && path === '/invoices') {
      const inv = { ...body, _id: `inv_${invoices.size + 1}`, invoiceNumber: `INV-${invoices.size + 1}`, status: 'draft' };
      invoices.set(inv._id, inv);
      return reply(201, inv);
    }
    const m = /^\/invoices\/([^/]+)(?:\/(send|cancel))?$/.exec(path);
    const inv = m && invoices.get(m[1]);
    if (!inv) return reply(404, { error: 'not found' });
    if (m[2]) inv.status = m[2] === 'send' ? 'sent' : 'cancelled';
    return reply(200, inv);
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, calls };
}

let dir = '';
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function setup(over: Partial<DemoDeps> = {}) {
  dir = mkdtempSync(join(tmpdir(), 'demo-test-'));
  const lines: string[] = [];
  const oncade = fakeOncade();
  const deps: DemoDeps = {
    env: ENV,
    runId: 'demo-test-run',
    webhookLog: join(dir, 'webhooks.jsonl'),
    out: (l) => lines.push(l),
    fetch: oncade.fetch,
    receiverUp: async () => true,
    sleep: async () => {},
    ...over,
  };
  return { deps, lines, calls: oncade.calls, text: () => lines.join('\n') };
}

const event = (name: string, invoiceId: string, status: string) =>
  JSON.stringify({ event: `Platform.Invoice.${name}`, data: { invoiceId, status }, receivedAt: 'now' }) + '\n';

describe('runDemo', () => {
  it('creates and sends A, creates and cancels B, reads both back, and explains how to enable webhooks', async () => {
    const t = setup({ receiverUp: async () => expect.fail('no secret: the receiver must not be probed') });
    expect(await runDemo(t.deps)).toBe(0);
    expect(t.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /invoices',
      'POST /invoices/inv_1/send',
      'POST /invoices',
      'POST /invoices/inv_2/cancel',
      'GET /invoices/inv_1',
      'GET /invoices/inv_2',
    ]);
    const create = t.calls[0].body;
    expect(create).toMatchObject({ receiverEmail: 'demo@example.com', payToTarget: 'BUSINESS' });
    expect(create.items).toEqual([expect.objectContaining({ quantity: 1, rate: 1, amount: 1 })]);
    expect(t.calls[1].body).toEqual({ sendEmail: false });
    // The two drafts differ, so their idempotency keys differ (a shared key would return A twice).
    const keys = t.calls.filter((c) => c.method === 'POST').map((c) => c.headers['Idempotency-Key']);
    expect(new Set(keys).size).toBe(4);
    expect(t.text()).toMatch(/5\. GET A: +id=inv_1 number=INV-1 status=sent/);
    expect(t.text()).toMatch(/GET B: +id=inv_2 number=INV-2 status=cancelled/);
    expect(t.text()).toContain('ONCADE_WEBHOOK_SECRET is not set');
    expect(t.text()).toContain('pnpm tunnel');

    // Same run id, same requests: the same keys (Oncade's idempotency makes a re-run a no-op).
    const again = setup();
    await runDemo({ ...again.deps, env: ENV, receiverUp: async () => false });
    expect(again.calls.filter((c) => c.method === 'POST').map((c) => c.headers['Idempotency-Key'])).toEqual(keys);
  });

  it('with a secret but no receiver running, skips the wait and says why', async () => {
    const t = setup({ env: { ...ENV, ONCADE_WEBHOOK_SECRET: 'whsec_test', WEBHOOK_PORT: '4555' } });
    let probed = 0;
    t.deps.receiverUp = async (port) => {
      probed = port;
      return false;
    };
    expect(await runDemo(t.deps)).toBe(0);
    expect(probed).toBe(4555);
    expect(t.text()).toContain('no receiver on 127.0.0.1:4555');
  });

  it('waits for the four webhooks of exactly these invoices and prints them', async () => {
    const t = setup({ env: { ...ENV, ONCADE_WEBHOOK_SECRET: 'whsec_test' } });
    appendFileSync(t.deps.webhookLog, event('Created', 'inv_1', 'draft') + event('Sent', 'other_inv', 'sent'));
    let sleeps = 0;
    t.deps.sleep = async () => {
      if (++sleeps === 2)
        appendFileSync(
          t.deps.webhookLog,
          'torn line\n' +
            event('Sent', 'inv_1', 'sent') +
            event('Created', 'inv_2', 'draft') +
            event('Cancelled', 'inv_2', 'cancelled'),
        );
    };
    expect(await runDemo(t.deps)).toBe(0);
    const received = t.lines.filter((l) => l.includes('received'));
    expect(received).toEqual([
      expect.stringContaining('Platform.Invoice.Created inv_1 (status=draft'),
      expect.stringContaining('Platform.Invoice.Sent inv_1 (status=sent'),
      expect.stringContaining('Platform.Invoice.Created inv_2 (status=draft'),
      expect.stringContaining('Platform.Invoice.Cancelled inv_2 (status=cancelled'),
    ]);
    expect(t.text()).not.toContain('other_inv');
    expect(t.text()).toContain('all four webhooks arrived');
    expect(sleeps).toBe(2);
  });

  it('times out with the missing events named and a hint, exit 1', async () => {
    const t = setup({ env: { ...ENV, ONCADE_WEBHOOK_SECRET: 'whsec_test' }, waitMs: 3000 });
    appendFileSync(t.deps.webhookLog, event('Created', 'inv_1', 'draft'));
    let sleeps = 0;
    t.deps.sleep = async () => void sleeps++;
    expect(await runDemo(t.deps)).toBe(1);
    expect(sleeps).toBe(3);
    expect(t.text()).toContain(
      'timed out after 3 s; missing: Platform.Invoice.Sent inv_1, Platform.Invoice.Created inv_2, Platform.Invoice.Cancelled inv_2.',
    );
    expect(t.text()).toContain('Check that `pnpm tunnel` is up');
  });

  it('without the Oncade variables names them and calls nothing; LLM and admin settings are not needed', async () => {
    const t = setup({ env: { AGENT_SANDBOX: 'not-a-mode', PORT: '3001' } });
    expect(await runDemo(t.deps)).toBe(1);
    expect(t.calls).toEqual([]);
    expect(t.text()).toContain('ONCADE_API_KEY: is required');
    expect(t.text()).toContain('ONCADE_BUSINESS_ID: is required');
    expect(t.text()).toContain('cp .env.example .env');
    expect(t.text()).not.toMatch(/AGENT_SANDBOX|ANTHROPIC|ADMIN_PASSWORD|WEBHOOK_PORT/);
  });
});
