/**
 * One screen: log in (admin/admin by default), ask one question, get one answer.
 * Plus the Oncade webhook receiver, which verifies the signature and appends events
 * to data/webhooks.jsonl for the agent's `recent_webhooks` tool.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import cookie from '@fastify/cookie';
import { loadEnv } from './env';
import { runAgent } from '../../agent/src/run-agent';
import { verifyOncadeSignature } from '../../../packages/oncade-client/src/webhook';

loadEnv();
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin';
const WEBHOOK_LOG = process.env.WEBHOOK_LOG!;

const app = Fastify({ logger: true });
await app.register(cookie, { secret: process.env.SESSION_SECRET ?? 'dev-only-change-me' });
await app.register(formbody);

// Webhooks need the raw bytes for the HMAC, so JSON bodies arrive as Buffers.
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

const authed = (req: { cookies: Record<string, string | undefined>; unsignCookie: (v: string) => { valid: boolean; value: string | null } }) => {
  const c = req.cookies.session;
  return !!c && req.unsignCookie(c).valid;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Oncade invoices agent</title>
<style>body{font:16px system-ui;max-width:760px;margin:40px auto;padding:0 16px}textarea,input{width:100%;font:inherit;padding:8px;box-sizing:border-box}
button{font:inherit;padding:8px 16px;margin-top:8px}pre{white-space:pre-wrap;background:#f4f4f5;padding:12px;border-radius:6px}.muted{color:#666;font-size:14px}</style></head>
<body><h1>Oncade invoices agent</h1>${body}</body></html>`;

app.get('/', (req, reply) => reply.redirect(authed(req) ? '/ask' : '/login'));

app.get('/login', (_req, reply) =>
  reply.type('text/html').send(
    page(`<form method="post" action="/login"><p><input name="user" placeholder="user" autofocus></p>
<p><input name="password" type="password" placeholder="password"></p><button>Log in</button></form>`),
  ),
);

app.post<{ Body: { user?: string; password?: string } }>('/login', (req, reply) => {
  if (req.body.user === ADMIN_USER && req.body.password === ADMIN_PASSWORD) {
    reply.setCookie('session', 'admin', { signed: true, httpOnly: true, sameSite: 'lax', path: '/' });
    return reply.redirect('/ask');
  }
  return reply.code(401).type('text/html').send(page('<p>Wrong user or password. <a href="/login">Try again</a></p>'));
});

const askForm = (q = '') => `<form method="post" action="/ask"><textarea name="q" rows="3" placeholder="e.g. Create a draft invoice for Acme, 10 hours at $50, and show me my last 5 invoices">${esc(q)}</textarea>
<button>Ask</button></form>`;

app.get('/ask', (req, reply) =>
  authed(req) ? reply.type('text/html').send(page(askForm())) : reply.redirect('/login'),
);

app.post<{ Body: { q?: string } }>('/ask', async (req, reply) => {
  if (!authed(req)) return reply.redirect('/login');
  const q = (req.body.q ?? '').trim().slice(0, 2000);
  if (!q) return reply.redirect('/ask');
  try {
    const r = await runAgent(q);
    const tools = r.toolCalls.map((t) => `${t.name} ${JSON.stringify(t.input)}`).join('\n') || 'none';
    return reply.type('text/html').send(
      page(`${askForm(q)}<h2>Answer</h2><pre>${esc(r.answer)}</pre>
<p class="muted">Tools used:</p><pre class="muted">${esc(tools)}</pre>
<p class="muted">sandboxed: ${r.sandboxed} · ${r.durationMs ?? '?'} ms · $${r.costUsd?.toFixed(4) ?? '?'}</p>`),
    );
  } catch (e) {
    req.log.error(e);
    return reply.code(500).type('text/html').send(page(`${askForm(q)}<h2>Agent failed</h2><pre>${esc(String(e))}</pre>`));
  }
});

app.post('/webhooks/oncade', (req, reply) => {
  const raw = req.body as Buffer;
  const sig = req.headers['x-oncade-signature'];
  if (!verifyOncadeSignature(raw, typeof sig === 'string' ? sig : undefined, process.env.ONCADE_WEBHOOK_SECRET ?? '')) {
    req.log.warn('webhook rejected: bad signature');
    return reply.code(401).send({ error: 'invalid signature' });
  }
  const event = JSON.parse(raw.toString('utf8'));
  mkdirSync(dirname(WEBHOOK_LOG), { recursive: true });
  appendFileSync(WEBHOOK_LOG, JSON.stringify({ receivedAt: new Date().toISOString(), ...event }) + '\n');
  req.log.info({ event: event.event }, 'webhook stored');
  return reply.send({ received: true });
});

await app.listen({ port: Number(process.env.PORT ?? 3000), host: '127.0.0.1' });
