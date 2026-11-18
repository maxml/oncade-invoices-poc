import { createHash, randomUUID } from 'node:crypto';

/** Minimal typed client for the Oncade Platform API (test environment). */
export class OncadeError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly endpoint: string,
  ) {
    super(`Oncade ${endpoint} -> ${status}: ${JSON.stringify(body)}`);
  }
}

export interface OncadeConfig {
  apiKey: string;
  businessId: string;
  baseUrl?: string;
  /**
   * Scope of write idempotency. Every write carries `Idempotency-Key = sha256(runId, method, path,
   * canonical body)`, so the same write repeated within one run (an agent retry, or our own retry
   * after a timeout) hits Oncade's idempotency and does not create a second invoice.
   * Defaults to one random id per client instance.
   */
  runId?: string;
  /** Per-attempt timeout. Default 15 s. */
  timeoutMs?: number;
  /** Total attempts for retryable failures (429, 5xx, network error, timeout). Default 3. */
  maxAttempts?: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface InvoiceItem {
  description: string;
  quantity: number;
  /** Dollars, per the Invoices guide. */
  rate: number;
  amount?: number;
}

export interface CreateInvoiceInput {
  receiverName: string;
  receiverEmail: string;
  date: string;
  dueDate?: string;
  items: InvoiceItem[];
  note?: string;
  externalMetadata?: Record<string, unknown>;
}

const DEFAULT_BASE = 'https://www.oncade.gg/api/v1/platform';

/** JSON with object keys sorted at every level, so equal inputs give equal bytes. */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return '';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/**
 * Deterministic Idempotency-Key for one write within one run. Oncade only accepts a UUID here
 * (400 "Invalid Idempotency-Key format. Expected UUID format."), so the SHA-256 of the operation
 * is laid out as a name-based UUID (first 16 bytes, version 5 and RFC 4122 variant bits set).
 */
export function idempotencyKey(runId: string, method: string, path: string, body: unknown): string {
  const b = createHash('sha256')
    .update([runId, method.toUpperCase(), path, canonicalJson(body)].join('\n'))
    .digest()
    .subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const RETRYABLE_STATUS = (s: number) => s === 429 || s >= 500;

export function createOncadeClient(cfg: OncadeConfig) {
  if (!cfg.apiKey.startsWith('oncade_platform_test_')) {
    // This proof of concept only ever talks to the test environment.
    throw new Error('Refusing to start: ONCADE_API_KEY is not a test key (oncade_platform_test_...)');
  }
  const base = cfg.baseUrl ?? DEFAULT_BASE;
  const runId = cfg.runId || randomUUID();
  const doFetch = cfg.fetch ?? fetch;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  const maxAttempts = Math.max(1, cfg.maxAttempts ?? 3);

  async function call<T>(method: string, path: string, opts: { body?: unknown; business?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cfg.apiKey}`,
      'X-Oncade-API-Version': 'v1',
    };
    if (opts.business !== false) headers['X-Target-Business-Id'] = cfg.businessId;
    // Every write gets a key derived from the operation and its input: a repeat is a no-op on
    // Oncade's side, which is also what makes retrying a write below safe.
    const isWrite = method !== 'GET';
    if (isWrite) headers['Idempotency-Key'] = idempotencyKey(runId, method, path, opts.body);
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    // GET is safe to repeat; a write only with its deterministic key (always set above).
    const retryable = !isWrite || !!headers['Idempotency-Key'];
    const endpoint = `${method} ${path}`;

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        // Network error or timeout (AbortSignal.timeout -> TimeoutError).
        if (retryable && attempt < maxAttempts) {
          await sleep(backoff(attempt));
          continue;
        }
        const reason = e instanceof Error && e.name === 'TimeoutError' ? `timeout after ${timeoutMs} ms` : String(e);
        throw new OncadeError(0, { error: reason, attempts: attempt }, endpoint);
      }
      const text = await res.text();
      const parsed: unknown = text ? safeJson(text) : null;
      if (res.ok) return parsed as T;
      if (retryable && RETRYABLE_STATUS(res.status) && attempt < maxAttempts) {
        await sleep(retryAfterMs(res.headers.get('retry-after')) ?? backoff(attempt));
        continue;
      }
      throw new OncadeError(res.status, parsed, endpoint);
    }
  }

  return {
    runId,
    me: () => call('GET', '/me', { business: false }),
    readiness: () => call('GET', '/business/readiness'),
    listInvoices: (q: { status?: string; limit?: number } = {}) => {
      const p = new URLSearchParams({ limit: String(q.limit ?? 20) });
      if (q.status) p.set('status', q.status);
      return call('GET', `/invoices?${p}`);
    },
    getInvoice: (id: string) => call('GET', `/invoices/${encodeURIComponent(id)}`),
    createDraftInvoice: (input: CreateInvoiceInput) =>
      call('POST', '/invoices', {
        body: {
          ...input,
          payToTarget: 'BUSINESS',
          items: input.items.map((i) => ({ ...i, amount: i.amount ?? i.quantity * i.rate })),
        },
      }),
    sendInvoice: (id: string, sendEmail = false) =>
      call('POST', `/invoices/${encodeURIComponent(id)}/send`, { body: { sendEmail } }),
    cancelInvoice: (id: string) => call('POST', `/invoices/${encodeURIComponent(id)}/cancel`),
    /** Ask a business admin to grant scopes (works around the owner grant missing invoice scopes). */
    createLinkSession: (requestedScopes: string[]) =>
      call('POST', '/link-sessions', { body: { requestedScopes }, business: false }),
  };
}

export type OncadeClient = ReturnType<typeof createOncadeClient>;

/** 250 ms, 500 ms, 1 s, ... capped at 4 s. */
function backoff(attempt: number): number {
  return Math.min(4_000, 250 * 2 ** (attempt - 1));
}

/** Retry-After in seconds (the HTTP-date form is ignored), capped at 10 s. */
function retryAfterMs(h: string | null): number | undefined {
  if (!h || !/^\d+$/.test(h.trim())) return undefined;
  return Math.min(10_000, Number(h) * 1000);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
