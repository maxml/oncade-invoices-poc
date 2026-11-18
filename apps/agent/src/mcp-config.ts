/** The `oncade` MCP server as the CLI starts it for one run, and the names of its write tools. */
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
export const WRITE_TOOLS = ['create_draft_invoice', 'send_invoice', 'cancel_invoice'];

/** The MCP config for one run; the mode and the write permissions live here, outside the model's reach. */
export function mcpConfig(opts: {
  readOnly: boolean;
  runId: string;
  allowedInvoices?: string[];
  allowedEmails?: string[];
  emailAllowed?: boolean;
}) {
  return {
    mcpServers: {
      oncade: {
        command: process.execPath,
        args: ['--import', 'tsx', join(ROOT, 'apps/mcp/src/server.ts')],
        cwd: ROOT,
        env: {
          ONCADE_READ_ONLY: opts.readOnly ? '1' : '0',
          ONCADE_RUN_ID: opts.runId,
          ONCADE_ALLOWED_INVOICES: (opts.allowedInvoices ?? []).join(','),
          ONCADE_ALLOWED_EMAILS: (opts.allowedEmails ?? []).join(','),
          ONCADE_EMAIL_ALLOWED: opts.emailAllowed === true ? '1' : '0',
        },
      },
    },
  };
}
