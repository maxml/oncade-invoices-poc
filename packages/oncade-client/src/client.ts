import { randomUUID } from 'node:crypto';

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

export function createOncadeClient(cfg: OncadeConfig) {
  if (!cfg.apiKey.startsWith('oncade_platform_test_')) {
    // This proof of concept only ever talks to the test environment.
    throw new Error('Refusing to start: ONCADE_API_KEY is not a test key (oncade_platform_test_...)');
  }
  const base = cfg.baseUrl ?? DEFAULT_BASE;

  async function call<T>(method: string, path: string, opts: { body?: unknown; business?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cfg.apiKey}`,
      'X-Oncade-API-Version': 'v1',
    };
    if (opts.business !== false) headers['X-Target-Business-Id'] = cfg.businessId;
    if (method !== 'GET' && method !== 'DELETE') headers['Idempotency-Key'] = randomUUID();
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    const parsed: unknown = text ? safeJson(text) : null;
    if (!res.ok) throw new OncadeError(res.status, parsed, `${method} ${path}`);
    return parsed as T;
  }

  return {
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
