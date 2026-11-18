import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentResult } from '../../agent/src/run-agent';
import { BudgetExceededError, BudgetLedgerError } from '../../agent/src/budget';
import {
  buildUiApp,
  buildWebhookApp,
  isDirectLocal,
  isLoopbackAddress,
  listenBoth,
  listenOptions,
  type HealthChecks,
  type UiAppOptions,
} from './app';
import { securityConfig } from './env';
import { RateLimiter } from './rate-limit';
import { WebhookStore } from './webhook-store';

const SECRET = 'whsec_test';
const PASSWORD = 'correct-horse-battery';
const security = { adminUser: 'admin', adminPassword: PASSWORD, sessionSecret: 'x'.repeat(40), insecureDefaults: false };
const sign = (b: string) => createHmac('sha256', SECRET).update(b).digest('hex');

const fakeResult = (over: Partial<AgentResult> = {}): AgentResult => ({
  answer: 'ok',
  toolCalls: [],
  isError: false,
  timedOut: false,
  sandboxed: true,
  runId: 'r',
  mode: 'read-only',
  model: 'm',
  promptVersion: 'v2',
  ...over,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const okHealth: HealthChecks = { oncade: async () => ({}), claude: () => '/usr/bin/claude' };

/** `app` is the UI app (PORT), `hooks` the webhook app (WEBHOOK_PORT). */
async function setup(over: Partial<UiAppOptions> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'oncade-app-test-'));
  dirs.push(d);
  const log = join(d, 'webhooks.jsonl');
  const runAgent = vi.fn(async (_q: string, _o: unknown) => fakeResult());
  const app = await buildUiApp({ security, runAgent, health: okHealth, ...over });
  const hooks = await buildWebhookApp({ webhookSecret: SECRET, webhookStore: new WebhookStore(log) });
  return { app, hooks, runAgent, log, dir: d };
}

type App = Awaited<ReturnType<typeof buildUiApp>>;

/** POST an HTML form (the page's forms are urlencoded). */
const form = (app: App, url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });

async function login(app: App) {
  const r = await form(app, '/login', { user: 'admin', password: PASSWORD });
  expect(r.statusCode).toBe(302);
  const c = r.cookies.find((x) => x.name === 'session')!;
  return `session=${c.value}`;
}

describe('securityConfig', () => {
  it('refuses missing or default ADMIN_PASSWORD / SESSION_SECRET', () => {
    expect(() => securityConfig({})).toThrow(/Refusing to start/);
    expect(() => securityConfig({ ADMIN_PASSWORD: 'admin', SESSION_SECRET: 'y'.repeat(40) })).toThrow(/ADMIN_PASSWORD/);
    expect(() => securityConfig({ ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: 'change-me' })).toThrow(/SESSION_SECRET/);
    expect(() => securityConfig({ ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: 'dev-only-change-me' })).toThrow(/SESSION_SECRET/);
  });

  it('refuses short values that are not on the default list (length is checked, not only the list)', () => {
    expect(() => securityConfig({ ADMIN_PASSWORD: 'Xq7-kP2-zR9', SESSION_SECRET: 'y'.repeat(40) })).toThrow(/ADMIN_PASSWORD/); // 11 chars
    expect(() => securityConfig({ ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: 'a1b2c3d4'.repeat(4).slice(0, 31) })).toThrow(
      /SESSION_SECRET/,
    );
    // The boundaries themselves are accepted.
    expect(securityConfig({ ADMIN_PASSWORD: 'Xq7-kP2-zR9!', SESSION_SECRET: 'a1b2c3d4'.repeat(4) }).insecureDefaults).toBe(false);
  });

  it('accepts strong values', () => {
    expect(securityConfig({ ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: 'y'.repeat(40) })).toMatchObject({
      insecureDefaults: false,
      adminUser: 'admin',
    });
  });

  it('allows defaults only with ALLOW_INSECURE_DEFAULTS=1, and flags them', () => {
    const c = securityConfig({ ALLOW_INSECURE_DEFAULTS: '1' });
    expect(c).toMatchObject({ insecureDefaults: true, adminPassword: 'admin' });
    expect(c.sessionSecret.length).toBeGreaterThanOrEqual(32);
    expect(() => securityConfig({ ALLOW_INSECURE_DEFAULTS: 'true' })).toThrow();
  });
});

describe('login and auth', () => {
  it('redirects to /login without a session, and to /ask after login', async () => {
    const { app } = await setup();
    expect((await app.inject('/ask')).headers.location).toBe('/login');
    const cookie = await login(app);
    const r = await app.inject({ url: '/ask', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Allow changes');
  });

  it('rejects a wrong password and a forged or unknown session cookie', async () => {
    const { app } = await setup();
    expect((await form(app, '/login', { user: 'admin', password: 'admin' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/ask', headers: { cookie: 'session=admin' } })).headers.location).toBe('/login');
    // Correctly signed by another server instance (same secret), but not a session this server issued.
    const other = await setup();
    const cookie = await login(other.app);
    expect((await app.inject({ url: '/ask', headers: { cookie } })).headers.location).toBe('/login');
  });

  it('rate-limits failed logins per IP, even for the right password afterwards', async () => {
    const { app } = await setup({ loginLimit: { max: 3, windowMs: 60_000 } });
    for (let i = 0; i < 3; i++) {
      expect((await form(app, '/login', { user: 'admin', password: `bad${i}` })).statusCode).toBe(401);
    }
    const r = await form(app, '/login', { user: 'admin', password: PASSWORD });
    expect(r.statusCode).toBe(429);
  });
});

describe('/ask', () => {
  it('runs read-only unless "Allow changes" is ticked', async () => {
    const { app, runAgent } = await setup();
    const cookie = await login(app);
    await form(app, '/ask', { q: 'cancel inv_1' }, { cookie });
    await form(app, '/ask', { q: 'cancel inv_1', allowChanges: '1' }, { cookie });
    expect(runAgent.mock.calls[0][1]).toMatchObject({ allowChanges: false });
    expect(runAgent.mock.calls[1][1]).toMatchObject({ allowChanges: true });
  });

  it('over the daily budget answers 429 with the reason, and frees the run lock', async () => {
    const runAgent = vi.fn(async () => {
      throw new BudgetExceededError(2.5, 2);
    });
    const { app } = await setup({ runAgent });
    const cookie = await login(app);
    const r = await form(app, '/ask', { q: 'list invoices' }, { cookie });
    expect(r.statusCode).toBe(429);
    expect(r.body).toContain('Daily agent budget of $2.00 reached');
    // The second 429 must be the budget again, not the one-run lock left held by the first request.
    const again = await form(app, '/ask', { q: 'again' }, { cookie });
    expect(again.statusCode).toBe(429);
    expect(again.body).not.toContain('Another question is being answered');
    expect(again.body).toContain('Daily agent budget of $2.00 reached');
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it('budget ledger unavailable answers 503 with the reason, not 500, and frees the run lock', async () => {
    const runAgent = vi.fn(async () => {
      throw new BudgetLedgerError('Cannot read the budget ledger /x/ledger.json (bad); no run started.');
    });
    const { app } = await setup({ runAgent });
    const cookie = await login(app);
    for (const q of ['list invoices', 'again']) {
      const r = await form(app, '/ask', { q }, { cookie });
      expect(r.statusCode).toBe(503);
      expect(r.body).toContain('Cannot read the budget ledger /x/ledger.json (bad); no run started.');
      expect(r.body).not.toContain('Agent failed');
    }
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it('rate-limits agent runs per session', async () => {
    const { app, runAgent } = await setup({ askLimit: { max: 2, windowMs: 60_000 } });
    const cookie = await login(app);
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await form(app, '/ask', { q: `q${i}` }, { cookie })).statusCode);
    expect(codes).toEqual([200, 200, 429]);
    expect(runAgent).toHaveBeenCalledTimes(2);
    // A fresh session has its own budget.
    const cookie2 = await login(app);
    expect((await form(app, '/ask', { q: 'x' }, { cookie: cookie2 })).statusCode).toBe(200);
  });

  it('allows one agent run per server at a time (second one gets 429, then works again)', async () => {
    // Only the first run blocks; any later run returns at once. Without the lock the second
    // request therefore gets a fast 200 and the assertion below fails, instead of a timeout.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let markStarted!: () => void;
    const started = new Promise<void>((r) => (markStarted = r));
    const runAgent = vi.fn(async () => {
      if (runAgent.mock.calls.length === 1) {
        markStarted();
        await gate;
      }
      return fakeResult();
    });
    const { app } = await setup({ runAgent });
    const cookie = await login(app);
    const first = form(app, '/ask', { q: 'slow' }, { cookie });
    await started;
    const second = await form(app, '/ask', { q: 'second' }, { cookie });
    expect(second.statusCode, 'second /ask while the first run is pending').toBe(429);
    expect(runAgent).toHaveBeenCalledTimes(1);
    release();
    expect((await first).statusCode).toBe(200);
    expect((await form(app, '/ask', { q: 'third' }, { cookie })).statusCode).toBe(200);
  });
});

describe('two ports: UI app vs webhook app', () => {
  const body = JSON.stringify({ event: 'Platform.Invoice.Sent', data: {}, timestamp: 't' });
  const webhook = (app: App, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/oncade',
      headers: { ...headers, 'content-type': 'application/json', 'x-oncade-signature': sign(body) },
      payload: body,
    });

  it.each([
    [{ 'x-forwarded-for': '1.2.3.4' }],
    [{ 'x-forwarded-host': 'abc.ngrok-free.app' }],
    [{ host: 'abc.ngrok-free.app' }],
    [{ host: 'localhost.evil.com' }],
    [{ forwarded: 'for=1.2.3.4' }],
  ])('UI app: a proxied request (%o) gets 404 on every path', async (headers) => {
    const { app } = await setup();
    for (const url of ['/', '/login', '/ask', '/healthz', '/nope'])
      expect((await app.inject({ url, headers })).statusCode).toBe(404);
    expect((await form(app, '/login', { user: 'admin', password: PASSWORD }, headers as Record<string, string>)).statusCode).toBe(
      404,
    );
  });

  it('UI app has no webhook route, even for a direct local request', async () => {
    const { app } = await setup();
    expect((await webhook(app)).statusCode).toBe(404);
  });

  it('webhook app exposes nothing but POST /webhooks/oncade (through the tunnel too)', async () => {
    const { hooks } = await setup();
    const tunnel = { 'x-forwarded-for': '1.2.3.4', host: 'abc.ngrok-free.app' };
    for (const url of ['/', '/login', '/ask', '/healthz', '/webhooks', '/webhooks/other']) {
      expect((await hooks.inject({ url, headers: tunnel })).statusCode, url).toBe(404);
    }
    expect((await form(hooks, '/login', { user: 'admin', password: PASSWORD }, tunnel)).statusCode).toBe(404);
    expect((await form(hooks, '/ask', { q: 'cancel everything', allowChanges: '1' }, tunnel)).statusCode).toBe(404);
    expect((await hooks.inject({ method: 'GET', url: '/webhooks/oncade', headers: tunnel })).statusCode).toBe(404);
    expect((await webhook(hooks, tunnel)).statusCode).toBe(200);
  });

  it('both apps listen on 127.0.0.1 only (the listen options the entry point uses)', async () => {
    expect(listenOptions(3000)).toEqual({ port: 3000, host: '127.0.0.1' });
    const { app, hooks } = await setup();
    try {
      await listenBoth(app, hooks, { ui: 0, webhook: 0 });
      for (const a of [app, hooks]) expect((a.server.address() as { address: string }).address).toBe('127.0.0.1');
    } finally {
      await app.close();
      await hooks.close();
    }
  });

  it('isLoopbackAddress', () => {
    expect(['127.0.0.1', '::1', '::ffff:127.0.0.1'].map(isLoopbackAddress)).toEqual([true, true, true]);
    expect(['10.0.0.1', '127.0.0.2', '', undefined].map(isLoopbackAddress)).toEqual([false, false, false, false]);
  });

  it('a request from a non-loopback socket gets 404 even with clean headers and a localhost Host', async () => {
    const { app } = await setup();
    for (const remoteAddress of ['10.0.0.5', '192.168.1.20', '::ffff:10.0.0.5']) {
      const r = await app.inject({ url: '/login', headers: { host: '127.0.0.1:3000' }, remoteAddress });
      expect(r.statusCode, remoteAddress).toBe(404);
    }
    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(
        (await app.inject({ url: '/login', headers: { host: '127.0.0.1:3000' }, remoteAddress })).statusCode,
        remoteAddress,
      ).toBe(200);
    }
  });

  it('direct local requests reach the app', async () => {
    const { app } = await setup();
    for (const host of ['localhost', '127.0.0.1:3000', 'localhost:3000', '[::1]:3000']) {
      expect((await app.inject({ url: '/login', headers: { host } })).statusCode).toBe(200);
    }
  });

  it('isDirectLocal', () => {
    expect(isDirectLocal({ host: '127.0.0.1:3000' })).toBe(true);
    expect(isDirectLocal({ host: '127.0.0.1:3000', 'x-real-ip': '1.1.1.1' })).toBe(false);
    expect(isDirectLocal({})).toBe(false);
  });
});

describe('GET /healthz', () => {
  it('200 with every check ok', async () => {
    const { app } = await setup();
    const r = await app.inject('/healthz');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      status: 'ok',
      checks: { process: { ok: true }, oncade: { ok: true }, claude: { ok: true } },
    });
  });

  it('503 when Oncade answers with an error, and says which status', async () => {
    const err = Object.assign(new Error('Oncade GET /me -> 401'), { status: 401 });
    const { app } = await setup({ health: { ...okHealth, oncade: async () => Promise.reject(err) } });
    const r = await app.inject('/healthz');
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({
      status: 'degraded',
      checks: { oncade: { ok: false, error: 'http 401' }, claude: { ok: true } },
    });
  });

  it('leaks no paths and no raw error text: the CLI is found or not, errors are a short category', async () => {
    const raw = 'connect ECONNREFUSED 10.1.2.3:443 while reading /home/dell/secret/.env';
    const health: HealthChecks = {
      oncade: async () => Promise.reject(Object.assign(new Error(raw), { status: 0 })),
      claude: () => '/home/dell/.local/bin/claude',
    };
    const { app } = await setup({ health });
    const r = await app.inject('/healthz');
    expect(r.body).not.toMatch(/\/home|\/usr|ECONNREFUSED|10\.1\.2\.3|secret/);
    expect(r.json().checks).toMatchObject({ oncade: { ok: false, error: 'network' }, claude: { ok: true } });
    expect(Object.keys(r.json().checks.claude)).toEqual(['ok']);
  });

  it('503 fast when Oncade hangs (short timeout), and when the claude CLI is missing', async () => {
    const hang = { ...okHealth, oncade: () => new Promise(() => {}), timeoutMs: 50 };
    const { app } = await setup({ health: hang });
    const t = Date.now();
    const r = await app.inject('/healthz');
    expect(Date.now() - t).toBeLessThan(1000);
    expect(r.json().checks.oncade).toMatchObject({ ok: false, error: 'timeout' });
    const noCli = await setup({ health: { ...okHealth, claude: () => null } });
    const r2 = await noCli.app.inject('/healthz');
    expect(r2.statusCode).toBe(503);
    expect(r2.json().checks.claude).toEqual({ ok: false });
  });
});

describe('POST /webhooks/oncade', () => {
  const post = (app: App, body: string, sig = sign(body)) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/oncade',
      headers: { 'content-type': 'application/json', 'x-oncade-signature': sig },
      payload: body,
    });
  const ev = JSON.stringify({
    event: 'Platform.Invoice.Created',
    data: { invoiceId: 'inv_1' },
    timestamp: '2026-11-18T00:00:00.000Z',
  });

  it('stores a valid event once; a replay of the same signed body is acknowledged but not stored', async () => {
    const { hooks: app, log } = await setup();
    const a = await post(app, ev);
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual({ received: true });
    const b = await post(app, ev);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual({ received: true, duplicate: true });
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      event: 'Platform.Invoice.Created',
      dedupeKey: expect.stringMatching(/^sha256:/),
    });
  });

  it('remembers seen events across a restart (keys are read back from the log)', async () => {
    const first = await setup();
    await post(first.hooks, ev);
    const again = await buildWebhookApp({ webhookSecret: SECRET, webhookStore: new WebhookStore(first.log) });
    expect((await post(again, ev)).json()).toEqual({ received: true, duplicate: true });
    expect(readFileSync(first.log, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('dedupes by the event id when the event has one', async () => {
    const { hooks: app, log } = await setup();
    await post(app, JSON.stringify({ id: 'evt_1', event: 'X', n: 1 }));
    expect((await post(app, JSON.stringify({ id: 'evt_1', event: 'X', n: 2 }))).json()).toMatchObject({ duplicate: true });
    expect(JSON.parse(readFileSync(log, 'utf8')).dedupeKey).toBe('id:evt_1');
  });

  it('rejects a bad signature with 401 and stores nothing', async () => {
    const { hooks: app, log } = await setup();
    expect((await post(app, ev, sign(ev + 'x'))).statusCode).toBe(401);
    expect((await post(app, ev, 'zz')).statusCode).toBe(401);
    expect(existsSync(log)).toBe(false);
  });

  it.each(['{not json', '[1,2]', '42', 'null'])(
    'a validly signed body that is not a JSON object (%s) gets 400, not 500',
    async (body) => {
      const { hooks: app, log } = await setup();
      const r = await post(app, body);
      expect(r.statusCode).toBe(400);
      expect(existsSync(log)).toBe(false);
    },
  );
});

describe('WebhookStore rotation', () => {
  it('rotates at the size cap and still dedupes events from the rotated file', () => {
    const d = mkdtempSync(join(tmpdir(), 'oncade-store-test-'));
    dirs.push(d);
    const f = join(d, 'w.jsonl');
    const s = new WebhookStore(f, 400);
    const evs = [0, 1, 2, 3, 4].map((i) => Buffer.from(JSON.stringify({ event: 'E', data: { i, pad: 'p'.repeat(100) } })));
    for (const e of evs) expect(s.ingest(e).status).toBe('stored');
    expect(existsSync(`${f}.1`)).toBe(true);
    expect(readFileSync(f).length).toBeLessThanOrEqual(400);
    // The newest event, and one that now lives only in the rotated file, are still duplicates.
    expect(s.ingest(evs[4]).status).toBe('duplicate');
    const inRotated = evs.find((e) => readFileSync(`${f}.1`, 'utf8').includes(`"i":${JSON.parse(e.toString()).data.i},`))!;
    expect(new WebhookStore(f, 400).ingest(inRotated).status).toBe('duplicate');
  });

  it('right after a rotation, the same instance still knows the events that moved into .1', () => {
    const d = mkdtempSync(join(tmpdir(), 'oncade-store-test-'));
    dirs.push(d);
    const f = join(d, 'w.jsonl');
    const s = new WebhookStore(f, 600); // one stored line is 264 bytes: two fit, the third rotates
    const ev = (i: number) => Buffer.from(JSON.stringify({ event: 'E', data: { i, pad: 'p'.repeat(100) } }));
    expect(s.ingest(ev(0)).status).toBe('stored');
    expect(s.ingest(ev(1)).status).toBe('stored');
    expect(existsSync(`${f}.1`)).toBe(false);
    expect(s.ingest(ev(2)).status).toBe('stored'); // this one triggers the rotation
    expect(existsSync(`${f}.1`)).toBe(true);
    expect(readFileSync(`${f}.1`, 'utf8')).toContain('"i":0,');
    // Same process, no restart: events 0 and 1 now live only in .1 and must still be duplicates.
    expect(s.ingest(ev(0)).status).toBe('duplicate');
    expect(s.ingest(ev(1)).status).toBe('duplicate');
  });

  /**
   * Oncade "Resend" re-delivers an event with the same event, timestamp and data. A key from the
   * raw body broke on two things: a re-delivery serialised differently, and a line stored by
   * older code without a `dedupeKey` (stored again as new, seen live).
   */
  const created = {
    event: 'Platform.Invoice.Created',
    data: { invoiceId: 'inv_1', amount: 10 },
    timestamp: '2026-11-18T00:00:00.000Z',
  };
  const reordered = Buffer.from(
    '{ "timestamp":"2026-11-18T00:00:00.000Z",\n  "data": {"amount":10, "invoiceId":"inv_1"},  "event":"Platform.Invoice.Created" }',
  );

  it('a legacy log line without dedupeKey + a re-delivery with other whitespace and key order: duplicate', () => {
    const d = mkdtempSync(join(tmpdir(), 'oncade-store-test-'));
    dirs.push(d);
    const f = join(d, 'w.jsonl');
    writeFileSync(f, JSON.stringify({ ...created, receivedAt: '2026-11-18T00:00:01.000Z' }) + '\n');
    expect(new WebhookStore(f).ingest(reordered).status).toBe('duplicate');
    expect(readFileSync(f, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('an event without a timestamp is identified by its whole content, without the fields the store added', () => {
    const d = mkdtempSync(join(tmpdir(), 'oncade-store-test-'));
    dirs.push(d);
    const f = join(d, 'w.jsonl');
    writeFileSync(f, JSON.stringify({ event: 'E', data: { a: 1 }, receivedAt: '2026-11-18T00:00:01.000Z' }) + '\n');
    const s = new WebhookStore(f);
    expect(s.ingest(Buffer.from('{"data":{"a":1},"event":"E"}')).status).toBe('duplicate');
    expect(s.ingest(Buffer.from('{"data":{"a":2},"event":"E"}')).status).toBe('stored');
  });

  it('a line stored with a raw-body key (ab1acbe) still dedupes a re-delivery serialised differently', () => {
    const d = mkdtempSync(join(tmpdir(), 'oncade-store-test-'));
    dirs.push(d);
    const f = join(d, 'w.jsonl');
    const old = `sha256:${createHmac('sha256', 'unrelated').update('x').digest('hex')}`; // any old-style key
    writeFileSync(f, JSON.stringify({ ...created, receivedAt: '2026-11-18T00:00:01.000Z', dedupeKey: old }) + '\n');
    expect(new WebhookStore(f).ingest(reordered).status).toBe('duplicate');
  });

  it('same process: a re-delivery serialised differently is a duplicate; another timestamp or data is not', () => {
    const d = mkdtempSync(join(tmpdir(), 'oncade-store-test-'));
    dirs.push(d);
    const s = new WebhookStore(join(d, 'w.jsonl'));
    expect(s.ingest(Buffer.from(JSON.stringify(created))).status).toBe('stored');
    expect(s.ingest(reordered).status).toBe('duplicate');
    expect(s.ingest(Buffer.from(JSON.stringify({ ...created, timestamp: '2026-11-18T00:00:02.000Z' }))).status).toBe('stored');
    expect(s.ingest(Buffer.from(JSON.stringify({ ...created, data: { invoiceId: 'inv_2', amount: 10 } }))).status).toBe('stored');
    expect(s.ingest(Buffer.from(JSON.stringify({ ...created, event: 'Platform.Invoice.Sent' }))).status).toBe('stored');
  });

  it('skips torn lines when loading keys', () => {
    const d = mkdtempSync(join(tmpdir(), 'oncade-store-test-'));
    dirs.push(d);
    const f = join(d, 'w.jsonl');
    writeFileSync(f, '{"torn":\n{"dedupeKey":"id:a"}\n');
    expect(new WebhookStore(f).ingest(Buffer.from('{"id":"a"}')).status).toBe('duplicate');
  });
});

describe('RateLimiter', () => {
  it('frees a slot after the window passes', () => {
    let t = 0;
    const l = new RateLimiter(2, 1000, () => t);
    expect([l.take('k'), l.take('k'), l.take('k')]).toEqual([true, true, false]);
    t = 1001;
    expect(l.take('k')).toBe(true);
  });
});
