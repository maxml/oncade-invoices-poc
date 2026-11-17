/**
 * Oncade invoices as an MCP server (stdio). The agent's only tools are these,
 * and the same server can be plugged into any MCP client (Claude Code, Codex, ...).
 */
import { readFileSync, existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createOncadeClient, OncadeError } from '../../../packages/oncade-client/src/client';

const client = createOncadeClient({
  apiKey: process.env.ONCADE_API_KEY ?? '',
  businessId: process.env.ONCADE_BUSINESS_ID ?? '',
});
const webhookLog = process.env.WEBHOOK_LOG ?? 'data/webhooks.jsonl';

const server = new McpServer({ name: 'oncade', version: '0.1.0' });

/** Wrap a call so API errors reach the model as data it can explain, not as a crash. */
async function tool(fn: () => Promise<unknown>) {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await fn(), null, 2) }] };
  } catch (e) {
    const err = e instanceof OncadeError ? { status: e.status, endpoint: e.endpoint, body: e.body } : { message: String(e) };
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: err }) }] };
  }
}

server.registerTool(
  'get_platform',
  { description: 'Platform record: environment, approved scopes, key scopes. Use first when access looks wrong.' },
  () => tool(() => client.me()),
);

server.registerTool(
  'get_business_readiness',
  { description: 'Whether the business is verified and has payout/address set up, with links for missing steps.' },
  () => tool(() => client.readiness()),
);

server.registerTool(
  'list_invoices',
  {
    description: 'List invoices of the business, newest first.',
    inputSchema: {
      status: z.enum(['draft', 'sent', 'processing', 'paid', 'cancelled']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  (a) => tool(() => client.listInvoices(a)),
);

server.registerTool(
  'get_invoice',
  { description: 'One invoice with status, items and payment summary.', inputSchema: { invoiceId: z.string() } },
  (a) => tool(() => client.getInvoice(a.invoiceId)),
);

server.registerTool(
  'create_draft_invoice',
  {
    description: 'Create a DRAFT invoice (not visible to the recipient until sent). Amounts in dollars.',
    inputSchema: {
      receiverName: z.string(),
      receiverEmail: z.string().email(),
      date: z.string().describe('ISO date, e.g. 2026-11-18'),
      dueDate: z.string().optional(),
      note: z.string().optional(),
      items: z
        .array(z.object({ description: z.string(), quantity: z.number().positive(), rate: z.number().positive() }))
        .min(1),
    },
  },
  (a) => tool(() => client.createDraftInvoice(a)),
);

server.registerTool(
  'send_invoice',
  {
    description: 'Move a draft invoice to sent. Email delivery is off unless sendEmail=true.',
    inputSchema: { invoiceId: z.string(), sendEmail: z.boolean().optional() },
  },
  (a) => tool(() => client.sendInvoice(a.invoiceId, a.sendEmail ?? false)),
);

server.registerTool(
  'cancel_invoice',
  { description: 'Cancel a draft or sent invoice. Terminal.', inputSchema: { invoiceId: z.string() } },
  (a) => tool(() => client.cancelInvoice(a.invoiceId)),
);

server.registerTool(
  'request_invoice_access',
  {
    description:
      'Create a link session asking the business admin to grant invoice scopes. Use when invoice calls fail with SCOPE_NOT_GRANTED; return the URL to the user.',
  },
  () => tool(() => client.createLinkSession(['invoice:create', 'invoice:read', 'invoice:update', 'invoice:send', 'invoice:cancel'])),
);

server.registerTool(
  'recent_webhooks',
  {
    description: 'Most recent verified webhook events received from Oncade (e.g. Platform.Invoice.Sent).',
    inputSchema: { limit: z.number().int().min(1).max(50).optional() },
  },
  (a) =>
    tool(async () => {
      if (!existsSync(webhookLog)) return [];
      const lines = readFileSync(webhookLog, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-(a.limit ?? 10)).map((l) => JSON.parse(l));
    }),
);

await server.connect(new StdioServerTransport());
