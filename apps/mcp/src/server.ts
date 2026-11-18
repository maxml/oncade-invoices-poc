/**
 * Oncade invoices as an MCP server (stdio). The agent's only tools are these,
 * and the same server can be plugged into any MCP client (Claude Code, Codex, ...).
 *
 * Environment (validated by packages/config, mapped by ./options.ts):
 * - ONCADE_READ_ONLY: write tools are registered only when it is exactly "0"; unset = read-only.
 * - ONCADE_ALLOWED_INVOICES: invoice ids / numbers named in the user's request; send and cancel
 *   are refused for any other invoice that this run did not create.
 * - ONCADE_RUN_ID scopes the deterministic Idempotency-Key of writes to one agent run.
 */
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, parseConfig } from '../../../packages/config/src/config';
import { createOncadeClient } from '../../../packages/oncade-client/src/client';
import { mcpOptions } from './options';
import { buildServer } from './tools';

const ROOT = resolve(import.meta.dirname, '../../..');

let config;
try {
  config = parseConfig(process.env);
} catch (e) {
  console.error(e instanceof ConfigError ? e.message : String(e));
  process.exit(1);
}
const opts = mcpOptions(config, ROOT);

const client = createOncadeClient({
  apiKey: config.ONCADE_API_KEY,
  businessId: config.ONCADE_BUSINESS_ID,
  runId: opts.runId,
});

await buildServer(client, opts).connect(new StdioServerTransport());
