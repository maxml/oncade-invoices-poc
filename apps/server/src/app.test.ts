import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentResult } from '../../agent/src/run-agent';
import { buildApp, isDirectLocal, type AppOptions } from './app';
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

async function setup(over: Partial<AppOptions> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'oncade-app-test-'));
  dirs.push(d);
  const log = join(d, 'webhooks.jsonl');
  const runAgent = vi.fn(async (_q: string, _o: unknown) => fakeResult());
  const app = await buildApp({
    security,
    runAgent,
    webhookSecret: SECRET,
    webhookStore: new WebhookStore(log),
    ...over,
  });
  return { app, runAgent, log, dir: d };
}

type App = Awaited<ReturnType<typeof buildApp>>;

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

  it('accepts strong values', () => {
    expect(securityConfig({ ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: 'y'.repeat(40) })).toMatchObject({ insecureDefaults: false, adminUser: 'admin' });
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
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runAgent = vi.fn(async () => {
      await gate;
      return fakeResult();
    });
    const { app } = await setup({ runAgent });
    const cookie = await login(app);
    const first = form(app, '/ask', { q: 'slow' }, { cookie });
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
    const second = await form(app, '/ask', { q: 'second' }, { cookie });
    expect(second.statusCode).toBe(429);
    release();
    expect((await first).statusCode).toBe(200);
    expect((await form(app, '/ask', { q: 'third' }, { cookie })).statusCode).toBe(200);
  });
});

describe('tunnel restriction', () => {
  it.each([
    [{ 'x-forwarded-for': '1.2.3.4' }],
    [{ 'x-forwarded-host': 'abc.ngrok-free.app' }],
    [{ host: 'abc.ngrok-free.app' }],
    [{ host: 'localhost.evil.com' }],
    [{ forwarded: 'for=1.2.3.4' }],
  ])('through a proxy (%o) only /webhooks/* exists', async (headers) => {
    const { app } = await setup();
    for (const url of ['/', '/login', '/ask', '/nope']) expect((await app.inject({ url, headers })).statusCode).toBe(404);
    expect((await form(app, '/login', { user: 'admin', password: PASSWORD }, headers as Record<string, string>)).statusCode).toBe(404);
    const body = JSON.stringify({ event: 'Platform.Invoice.Sent', data: {}, timestamp: 't' });
    const wh = await app.inject({
      method: 'POST',
      url: '/webhooks/oncade',
      headers: { ...headers, 'content-type': 'application/json', 'x-oncade-signature': sign(body) },
      payload: body,
    });
    expect(wh.statusCode).toBe(200);
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

describe('POST /webhooks/oncade', () => {
  const post = (app: Awaited<ReturnType<typeof buildApp>>, body: string, sig = sign(body)) =>
    app.inject({ method: 'POST', url: '/webhooks/oncade', headers: { 'content-type': 'application/json', 'x-oncade-signature': sig }, payload: body });
  const ev = JSON.stringify({ event: 'Platform.Invoice.Created', data: { invoiceId: 'inv_1' }, timestamp: '2026-11-18T00:00:00.000Z' });

  it('stores a valid event once; a replay of the same signed body is acknowledged but not stored', async () => {
    const { app, log } = await setup();
    const a = await post(app, ev);
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual({ received: true });
    const b = await post(app, ev);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual({ received: true, duplicate: true });
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'Platform.Invoice.Created', dedupeKey: expect.stringMatching(/^sha256:/) });
  });

  it('remembers seen events across a restart (keys are read back from the log)', async () => {
    const first = await setup();
    await post(first.app, ev);
    const again = await buildApp({ security, runAgent: vi.fn(), webhookSecret: SECRET, webhookStore: new WebhookStore(first.log) });
    expect((await post(again, ev)).json()).toEqual({ received: true, duplicate: true });
    expect(readFileSync(first.log, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('dedupes by the event id when the event has one', async () => {
    const { app, log } = await setup();
    await post(app, JSON.stringify({ id: 'evt_1', event: 'X', n: 1 }));
    expect((await post(app, JSON.stringify({ id: 'evt_1', event: 'X', n: 2 }))).json()).toMatchObject({ duplicate: true });
    expect(JSON.parse(readFileSync(log, 'utf8')).dedupeKey).toBe('id:evt_1');
  });

  it('rejects a bad signature with 401 and stores nothing', async () => {
    const { app, log } = await setup();
    expect((await post(app, ev, sign(ev + 'x'))).statusCode).toBe(401);
    expect((await post(app, ev, 'zz')).statusCode).toBe(401);
    expect(existsSync(log)).toBe(false);
  });

  it.each(['{not json', '[1,2]', '42', 'null'])('a validly signed body that is not a JSON object (%s) gets 400, not 500', async (body) => {
    const { app, log } = await setup();
    const r = await post(app, body);
    expect(r.statusCode).toBe(400);
    expect(existsSync(log)).toBe(false);
  });
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
