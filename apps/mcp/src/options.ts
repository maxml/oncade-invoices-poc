/** The MCP server's options, derived from the validated environment runAgent gives it. */
import { join } from 'node:path';
import type { Config } from '../../../packages/config/src/config';
import type { ToolOptions } from './tools';
import { parseAllowedInvoices } from './write-guard';

export function mcpOptions(c: Config, root: string): ToolOptions & { runId?: string } {
  return {
    // Fail closed: only the exact value "0" turns the write tools on; unset or anything else is read-only.
    readOnly: c.ONCADE_READ_ONLY !== '0',
    allowedInvoices: parseAllowedInvoices(c.ONCADE_ALLOWED_INVOICES),
    runId: c.ONCADE_RUN_ID,
    webhookLog: c.WEBHOOK_LOG ?? join(root, 'data/webhooks.jsonl'),
    linkSessionCache: c.LINK_SESSION_CACHE ?? join(root, 'data/state/link-session.json'),
  };
}
