import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, createOncadeClient, idempotencyKey, OncadeError } from './client';

const KEY = 'oncade_platform_test_fake';

type Call = { url: string; init: RequestInit & { headers: Record<string, string> } };

/** fetch stub that answers from a queue of responses (or throws an Error from it). */
function stubFetch(queue: (Response | Error)[]) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    const next = queue.shift() ?? new Response('{}', { status: 200 });
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: f as unknown as typeof fetch, calls };
}

const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const noSleep = async () => {};

const invoice = {
  receiverName: 'Acme',
  receiverEmail: 'billing@acme.example',
  date: '2026-11-18',
  items: [{ description: 'Consulting', quantity: 10, rate: 50 }],
};

describe('createOncadeClient', () => {
  it('refuses a non-test key', () => {
    expect(() => createOncadeClient({ apiKey: 'oncade_platform_live_x', businessId: 'b' })).toThrow(/test key/);
  });

  it('sends auth, version and business headers; no idempotency key on GET', async () => {
    const s = stubFetch([json(200, { invoices: [] })]);
    const c = createOncadeClient({ apiKey: KEY, businessId: 'biz_1', fetch: s.fetch, sleep: noSleep });
    await c.listInvoices({ limit: 5 });
    const h = s.calls[0].init.headers;
    expect(s.calls[0].url).toBe('https://www.oncade.gg/api/v1/platform/invoices?limit=5');
    expect(h.Authorization).toBe(`Bearer ${KEY}`);
    expect(h['X-Oncade-API-Version']).toBe('v1');
    expect(h['X-Target-Business-Id']).toBe('biz_1');
    expect(h['Idempotency-Key']).toBeUndefined();
    expect(s.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits the business header on platform-level calls', async () => {
    const s = stubFetch([json(200)]);
    const c = createOncadeClient({ apiKey: KEY, businessId: 'biz_1', fetch: s.fetch, sleep: noSleep });
    await c.me();
    expect(s.calls[0].init.headers['X-Target-Business-Id']).toBeUndefined();
  });

  it('derives the same Idempotency-Key for the same write within one run (agent retry = no second invoice)', async () => {
    const s = stubFetch([json(201), json(201), json(201), json(201)]);
    const a = createOncadeClient({ apiKey: KEY, businessId: 'b', runId: 'run-1', fetch: s.fetch, sleep: noSleep });
    await a.createDraftInvoice(invoice);
    // Same input, keys in another order: still the same operation.
    await a.createDraftInvoice({
      items: invoice.items,
      date: invoice.date,
      receiverEmail: invoice.receiverEmail,
      receiverName: 'Acme',
    });
    // A different input in the same run is a different operation.
    await a.createDraftInvoice({ ...invoice, receiverName: 'Globex' });
    // The same input in another run is a new operation.
    const b = createOncadeClient({ apiKey: KEY, businessId: 'b', runId: 'run-2', fetch: s.fetch, sleep: noSleep });
    await b.createDraftInvoice(invoice);
    const keys = s.calls.map((c) => c.init.headers['Idempotency-Key']);
    // Oncade rejects anything that is not a UUID (400 "Expected UUID format").
    expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
  });

  it('puts a key on body-less writes too (cancel), stable per run and invoice', async () => {
    const s = stubFetch([json(200), json(200), json(200)]);
    const c = createOncadeClient({ apiKey: KEY, businessId: 'b', runId: 'r', fetch: s.fetch, sleep: noSleep });
    await c.cancelInvoice('inv_1');
    await c.cancelInvoice('inv_1');
    await c.cancelInvoice('inv_2');
    const keys = s.calls.map((x) => x.init.headers['Idempotency-Key']);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('retries GET on 429 and 5xx with backoff, then succeeds', async () => {
    const s = stubFetch([json(429, {}, { 'retry-after': '1' }), json(503), json(200, { ok: 1 })]);
    const sleeps: number[] = [];
    const c = createOncadeClient({ apiKey: KEY, businessId: 'b', fetch: s.fetch, sleep: async (ms) => void sleeps.push(ms) });
    await expect(c.readiness()).resolves.toEqual({ ok: 1 });
    expect(s.calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 500]);
  });

  it('retries a write with the same Idempotency-Key on every attempt', async () => {
    const s = stubFetch([json(502), new TypeError('fetch failed'), json(201, { _id: 'inv' })]);
    const c = createOncadeClient({ apiKey: KEY, businessId: 'b', fetch: s.fetch, sleep: noSleep });
    await expect(c.createDraftInvoice(invoice)).resolves.toEqual({ _id: 'inv' });
    const keys = new Set(s.calls.map((x) => x.init.headers['Idempotency-Key']));
    expect(s.calls).toHaveLength(3);
    expect(keys.size).toBe(1);
  });

  it('stops after maxAttempts and throws the last status', async () => {
    const s = stubFetch([json(500), json(500), json(500), json(200)]);
    const c = createOncadeClient({ apiKey: KEY, businessId: 'b', fetch: s.fetch, sleep: noSleep, maxAttempts: 3 });
    await expect(c.readiness()).rejects.toMatchObject({ status: 500 });
    expect(s.calls).toHaveLength(3);
  });

  it('does not retry a 4xx other than 429', async () => {
    const s = stubFetch([json(403, { code: 'SCOPE_NOT_GRANTED' }), json(200)]);
    const c = createOncadeClient({ apiKey: KEY, businessId: 'b', fetch: s.fetch, sleep: noSleep });
    const err = (await c.listInvoices().catch((e: OncadeError) => e)) as OncadeError;
    expect(err).toBeInstanceOf(OncadeError);
    expect(err.status).toBe(403);
    expect(s.calls).toHaveLength(1);
  });

  it('aborts a hanging request after timeoutMs and reports a timeout', async () => {
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_ok, fail) => init.signal!.addEventListener('abort', () => fail(init.signal!.reason))),
    );
    const c = createOncadeClient({
      apiKey: KEY,
      businessId: 'b',
      fetch: hanging as unknown as typeof fetch,
      sleep: noSleep,
      timeoutMs: 30,
      maxAttempts: 2,
    });
    const err = (await c.readiness().catch((e: OncadeError) => e)) as OncadeError & { body: { error: string } };
    expect(err).toBeInstanceOf(OncadeError);
    expect(err.body.error).toMatch(/timeout after 30 ms/);
    expect(hanging).toHaveBeenCalledTimes(2);
  });
});

describe('idempotencyKey', () => {
  // Known vectors computed outside this code (Python hashlib over "runId\nMETHOD\npath\ncanonical body",
  // first 16 bytes, version 5 and RFC 4122 variant bits), so a change to what is hashed shows up here.
  it('matches fixed vectors', () => {
    expect(idempotencyKey('run-1', 'POST', '/invoices/abc/send', { b: 1, a: 'x' })).toBe('8befe33f-3e47-5994-947f-76e84bed4251');
    expect(idempotencyKey('run-1', 'PUT', '/invoices/abc/send', { b: 1, a: 'x' })).toBe('27214d6e-d91b-5627-b29a-4b8cdc258b28');
  });

  it('differs by method for the same run, path and body', () => {
    const body = { sendEmail: false };
    expect(idempotencyKey('r', 'POST', '/invoices/1/send', body)).not.toBe(idempotencyKey('r', 'PUT', '/invoices/1/send', body));
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  });
});
