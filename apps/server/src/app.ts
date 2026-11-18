/**
 * Two Fastify apps, served on two ports by server.ts:
 *
 * - The UI app (PORT, bound to 127.0.0.1): log in, ask one question, get one answer; /healthz.
 *   It has no webhook route. Defence in depth: a request that carries proxy headers, a
 *   non-loopback Host or comes from a non-loopback socket gets 404.
 * - The webhook app (WEBHOOK_PORT): only POST /webhooks/oncade, which verifies the signature,
 *   drops duplicates and appends events to data/webhooks.jsonl. `pnpm tunnel` exposes this port
 *   and nothing else, so the login page and the agent are not reachable through the tunnel at all.
 *
 * Built by functions with injected dependencies so the routes can be tested with fastify.inject.
 */
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import formbody from '@fastify/formbody';
import cookie from '@fastify/cookie';
import type { AgentOptions, AgentResult } from '../../agent/src/run-agent';
import { BudgetExceededError, BudgetLedgerError } from '../../agent/src/budget';
import { verifyOncadeSignature } from '../../../packages/oncade-client/src/webhook';
import type { SecurityConfig } from './env';
import { RateLimiter } from './rate-limit';
import type { WebhookStore } from './webhook-store';

/** Dependencies of GET /healthz. */
export interface HealthChecks {
  /** A cheap Oncade call (GET /me); resolves when Oncade answered. */
  oncade: () => Promise<unknown>;
  /** Path of the claude CLI, or null when it is not installed. */
  claude: () => string | null;
  /** Timeout for the Oncade check. Default 3 s. */
  timeoutMs?: number;
}

export interface UiAppOptions {
  security: SecurityConfig;
  runAgent: (prompt: string, opts: AgentOptions) => Promise<AgentResult>;
  health: HealthChecks;
  logger?: boolean;
  /** Failed logins per client IP. Default 5 per 15 min. */
  loginLimit?: { max: number; windowMs: number };
  /** Agent runs per session. Default 10 per 10 min. */
  askLimit?: { max: number; windowMs: number };
  now?: () => number;
}

export interface WebhookAppOptions {
  webhookSecret: string;
  webhookStore: WebhookStore;
  logger?: boolean;
}

const SESSION_TTL_MS = 12 * 60 * 60_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip'];

/**
 * A request is "direct local" only if no proxy header is present and the Host is a loopback name.
 * Anything that came through ngrok (or any proxy) fails this check.
 */
export function isDirectLocal(headers: Record<string, string | string[] | undefined>): boolean {
  if (PROXY_HEADERS.some((h) => headers[h] !== undefined)) return false;
  const host = String(headers.host ?? '').toLowerCase();
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOCAL_HOSTS.has(name);
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  return addr !== undefined && LOOPBACK_ADDRESSES.has(addr);
}

/** Both listeners bind to loopback only; the tunnel reaches the webhook port through ngrok on this host. */
export const LISTEN_HOST = '127.0.0.1';

export function listenOptions(port: number): { port: number; host: string } {
  return { port, host: LISTEN_HOST };
}

/** What server.ts does: the UI on `ports.ui`, the webhook receiver on `ports.webhook`, both on loopback. */
export async function listenBoth(ui: FastifyInstance, webhooks: FastifyInstance, ports: { ui: number; webhook: number }) {
  await ui.listen(listenOptions(ports.ui));
  await webhooks.listen(listenOptions(ports.webhook));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const notFound = { message: 'Not Found', statusCode: 404 };

export async function buildUiApp(o: UiAppOptions): Promise<FastifyInstance> {
  const now = o.now ?? Date.now;
  const loginLimiter = new RateLimiter(o.loginLimit?.max ?? 5, o.loginLimit?.windowMs ?? 15 * 60_000, now);
  const askLimiter = new RateLimiter(o.askLimit?.max ?? 10, o.askLimit?.windowMs ?? 10 * 60_000, now);
  const sessions = new Map<string, number>(); // session id -> created at
  let agentRunning = false;

  const app = Fastify({ logger: o.logger ?? false });
  await app.register(cookie, { secret: o.security.sessionSecret });
  await app.register(formbody);

  // The UI port is bound to 127.0.0.1 and never tunnelled. Defence in depth: anything that looks
  // proxied, names a non-loopback Host, or arrives on a non-loopback socket gets 404.
  app.addHook('onRequest', async (req, reply) => {
    if (isDirectLocal(req.headers) && isLoopbackAddress(req.socket.remoteAddress)) return;
    return reply.code(404).send(notFound);
  });

  // No paths and no raw error text in the body: the CLI is found or not, an Oncade failure is a
  // short category (timeout / http <status> / network). Details go to the server log.
  app.get('/healthz', async (req, reply) => {
    const timeoutMs = o.health.timeoutMs ?? 3_000;
    const started = Date.now();
    const TIMEOUT = Symbol('timeout');
    let oncade: { ok: boolean; ms: number; error?: string };
    try {
      await Promise.race([o.health.oncade(), new Promise((_ok, fail) => setTimeout(() => fail(TIMEOUT), timeoutMs).unref())]);
      oncade = { ok: true, ms: Date.now() - started };
    } catch (e) {
      const status = (e as { status?: unknown } | null)?.status;
      const name = (e as { name?: unknown } | null)?.name;
      const body = JSON.stringify((e as { body?: unknown } | null)?.body ?? '');
      const error =
        e === TIMEOUT || name === 'TimeoutError' || /timeout/i.test(body)
          ? 'timeout'
          : typeof status === 'number' && status > 0
            ? `http ${status}`
            : 'network';
      if (e !== TIMEOUT) req.log.warn({ err: e }, `healthz: Oncade check failed (${error})`);
      oncade = { ok: false, ms: Date.now() - started, error };
    }
    const checks = {
      process: { ok: true, uptimeS: Math.round(process.uptime()) },
      oncade,
      claude: { ok: o.health.claude() !== null },
    };
    const ok = checks.oncade.ok && checks.claude.ok;
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks });
  });

  const sessionOf = (req: FastifyRequest): string | null => {
    const c = req.cookies.session;
    if (!c) return null;
    const u = req.unsignCookie(c);
    if (!u.valid || !u.value) return null;
    const created = sessions.get(u.value);
    if (created === undefined || now() - created > SESSION_TTL_MS) return null;
    return u.value;
  };

  const banner = o.security.insecureDefaults
    ? '<p class="warn">Insecure demo mode (ALLOW_INSECURE_DEFAULTS=1): default password and session secret.</p>'
    : '';
  const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Oncade invoices agent</title>
<style>body{font:16px system-ui;max-width:760px;margin:40px auto;padding:0 16px}textarea,input[type=text],input[type=password],input:not([type]){width:100%;font:inherit;padding:8px;box-sizing:border-box}
button{font:inherit;padding:8px 16px;margin-top:8px}pre{white-space:pre-wrap;background:#f4f4f5;padding:12px;border-radius:6px}.muted{color:#666;font-size:14px}.warn{color:#b91c1c;font-weight:600}</style></head>
<body><h1>Oncade invoices agent</h1>${banner}${body}</body></html>`;

  app.get('/', (req, reply) => reply.redirect(sessionOf(req) ? '/ask' : '/login'));

  app.get('/login', (_req, reply) =>
    reply.type('text/html').send(
      page(`<form method="post" action="/login"><p><input name="user" placeholder="user" autofocus></p>
<p><input name="password" type="password" placeholder="password"></p><button>Log in</button></form>`),
    ),
  );

  app.post<{ Body: { user?: string; password?: string } }>('/login', (req, reply) => {
    const ipKey = req.ip;
    if (loginLimiter.blocked(ipKey)) {
      return reply.code(429).type('text/html').send(page('<p>Too many failed logins. Try again later.</p>'));
    }
    if (req.body?.user === o.security.adminUser && req.body?.password === o.security.adminPassword) {
      loginLimiter.reset(ipKey);
      const sid = randomBytes(24).toString('base64url');
      sessions.set(sid, now());
      reply.setCookie('session', sid, {
        signed: true,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_TTL_MS / 1000,
      });
      return reply.redirect('/ask');
    }
    loginLimiter.take(ipKey);
    return reply.code(401).type('text/html').send(page('<p>Wrong user or password. <a href="/login">Try again</a></p>'));
  });

  const askForm = (
    q = '',
    allowChanges = false,
  ) => `<form method="post" action="/ask"><textarea name="q" rows="3" placeholder="e.g. Create a draft invoice for Acme, billing@acme.example, 10 hours at $50">${esc(q)}</textarea>
<label class="muted"><input type="checkbox" name="allowChanges" value="1"${allowChanges ? ' checked' : ''}> Allow changes (create, send, cancel). Off: the agent can only read and propose.</label><br>
<button>Ask</button></form>`;

  app.get('/ask', (req, reply) => (sessionOf(req) ? reply.type('text/html').send(page(askForm())) : reply.redirect('/login')));

  app.post<{ Body: { q?: string; allowChanges?: string } }>('/ask', async (req, reply) => {
    const sid = sessionOf(req);
    if (!sid) return reply.redirect('/login');
    const q = (req.body?.q ?? '').trim().slice(0, 2000);
    const allowChanges = req.body?.allowChanges === '1';
    if (!q) return reply.redirect('/ask');
    if (!askLimiter.take(sid)) {
      return reply
        .code(429)
        .type('text/html')
        .send(page(`${askForm(q, allowChanges)}<p>Too many questions in a short time. Wait a few minutes.</p>`));
    }
    // One agent run per server at a time: each run spawns the CLI and the MCP server.
    if (agentRunning) {
      return reply
        .code(429)
        .type('text/html')
        .send(page(`${askForm(q, allowChanges)}<p>Another question is being answered. Try again in a moment.</p>`));
    }
    agentRunning = true;
    try {
      const r = await o.runAgent(q, { allowChanges, source: 'web' });
      const tools = r.toolCalls.map((t) => `${t.name} ${JSON.stringify(t.input)}`).join('\n') || 'none';
      return reply.type('text/html').send(
        page(`${askForm(q, allowChanges)}<h2>Answer</h2><pre>${esc(r.answer)}</pre>
<p class="muted">Tools used:</p><pre class="muted">${esc(tools)}</pre>
<p class="muted">${r.mode} · sandboxed: ${r.sandboxed} · ${r.durationMs ?? '?'} ms · ${r.costEstimated ? '~' : ''}$${r.costUsd?.toFixed(4) ?? '?'}${r.costEstimated ? ' (estimated)' : ''} · prompt ${esc(r.promptVersion)}</p>`),
      );
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        req.log.warn({ spentUsd: e.spentUsd, reservedUsd: e.reservedUsd, capUsd: e.capUsd }, 'daily agent budget reached');
        return reply
          .code(429)
          .type('text/html')
          .send(page(`${askForm(q, allowChanges)}<p class="warn">${esc(e.message)}</p>`));
      }
      if (e instanceof BudgetLedgerError) {
        req.log.error(e, 'budget ledger unavailable: run refused');
        return reply
          .code(503)
          .type('text/html')
          .send(page(`${askForm(q, allowChanges)}<p class="warn">${esc(e.message)}</p>`));
      }
      req.log.error(e);
      return reply
        .code(500)
        .type('text/html')
        .send(page(`${askForm(q, allowChanges)}<h2>Agent failed</h2><pre>${esc(String(e))}</pre>`));
    } finally {
      agentRunning = false;
    }
  });

  return app;
}

/** The only thing on the webhook port: POST /webhooks/oncade. Every other path is Fastify's 404. */
export async function buildWebhookApp(o: WebhookAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: o.logger ?? false });
  // The HMAC covers the exact bytes, so JSON bodies arrive as Buffers.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/oncade', (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const sig = req.headers['x-oncade-signature'];
    if (!verifyOncadeSignature(raw, typeof sig === 'string' ? sig : undefined, o.webhookSecret)) {
      req.log.warn('webhook rejected: bad signature');
      return reply.code(401).send({ error: 'invalid signature' });
    }
    const r = o.webhookStore.ingest(raw);
    if (r.status === 'invalid_json') {
      req.log.warn('webhook rejected: signed body is not a JSON object');
      return reply.code(400).send({ error: 'invalid JSON' });
    }
    if (r.status === 'duplicate') {
      req.log.info({ key: r.key }, 'webhook duplicate ignored');
      return reply.send({ received: true, duplicate: true });
    }
    req.log.info({ event: r.event }, 'webhook stored');
    return reply.send({ received: true });
  });

  return app;
}
