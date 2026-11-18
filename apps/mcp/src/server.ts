/**
 * Oncade invoices as an MCP server (stdio). The agent's only tools are these,
 * and the same server can be plugged into any MCP client (Claude Code, Codex, ...).
 *
 * ONCADE_READ_ONLY=1 (default unless set to 0): the write tools are not registered.
 * ONCADE_RUN_ID scopes the deterministic Idempotency-Key of writes to one agent run.
 */
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOncadeClient } from '../../../packages/oncade-client/src/client';
import { buildServer } from './tools';

const ROOT = resolve(import.meta.dirname, '../../..');

const client = createOncadeClient({
  apiKey: process.env.ONCADE_API_KEY ?? '',
  businessId: process.env.ONCADE_BUSINESS_ID ?? '',
  runId: process.env.ONCADE_RUN_ID,
});

const server = buildServer(client, {
  readOnly: process.env.ONCADE_READ_ONLY !== '0',
  webhookLog: process.env.WEBHOOK_LOG ?? resolve(ROOT, 'data/webhooks.jsonl'),
  linkSessionCache: process.env.LINK_SESSION_CACHE ?? resolve(ROOT, 'data/state/link-session.json'),
});

await server.connect(new StdioServerTransport());
