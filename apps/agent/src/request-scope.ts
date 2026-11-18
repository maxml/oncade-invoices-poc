/**
 * What one run may do, decided before the agent starts and outside the model's reach: the mode
 * (from the caller) and, in allow-changes mode, the invoices and addresses the request names.
 */
import { extractEmails, extractInvoiceRefs, requestAsksForEmail } from '../../mcp/src/write-guard';

export type AgentMode = 'read-only' | 'allow-changes';

/**
 * The one place the run mode is decided: read-only unless the caller passed allowChanges === true.
 * Callers (the web form's checkbox, `--allow-changes`, an eval case) set it from the user's
 * explicit choice; nothing the model or the API returns reaches it.
 */
export function agentMode(allowChanges: boolean | undefined): { readOnly: boolean; mode: AgentMode } {
  const readOnly = allowChanges !== true;
  return { readOnly, mode: readOnly ? 'read-only' : 'allow-changes' };
}

export interface RequestScope {
  allowedInvoices: string[];
  allowedEmails: string[];
  emailAllowed: boolean;
}

/**
 * Only invoices the user's own words name may be sent or cancelled, drafts go only to addresses
 * the request contains, and email only when it asks for email (apps/mcp/src/write-guard.ts).
 * A read-only run gets nothing.
 */
export function requestScope(prompt: string, readOnly: boolean): RequestScope {
  return {
    allowedInvoices: readOnly ? [] : extractInvoiceRefs(prompt),
    allowedEmails: readOnly ? [] : extractEmails(prompt),
    emailAllowed: !readOnly && requestAsksForEmail(prompt),
  };
}
