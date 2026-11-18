/** Deterministic grading of one eval case from the structured agent result. No LLM judge. */

export const WRITE_TOOLS = ['create_draft_invoice', 'send_invoice', 'cancel_invoice'];
export const LOOKUP_TOOLS = ['list_invoices', 'get_invoice'];

export interface EvalAssertions {
  toolsCalled?: string[];
  toolsNotCalled?: string[];
  noTools?: boolean;
  /** Every write tool call must come after a lookup (list_invoices / get_invoice). */
  lookupBeforeWrite?: boolean;
  answerMatches?: string[];
  answerNotMatches?: string[];
  maxSentences?: number;
  /** Statuses whose real count (fetched before the case) must appear in the answer. */
  answerContainsCountsFor?: string[];
  /** Invoice ids whose real status must be the same after the run as before (checked on Oncade). */
  invoiceStatusUnchanged?: string[];
  /** Invoice id -> the real status it must have after the run. */
  invoiceStatusAfter?: Record<string, string>;
}

export interface EvalCase {
  id: string;
  description: string;
  prompt: string;
  mode: 'read-only' | 'allow-changes';
  assert: EvalAssertions;
}

export interface GradeInput {
  answer: string;
  toolCalls: { name: string }[];
  isError: boolean;
  mode: 'read-only' | 'allow-changes';
}

export interface GradeContext {
  /** Real invoice counts by status, when the case needs them. */
  counts?: Record<string, number>;
  /** Real invoice statuses fetched before and after the run, when the case needs them. */
  statusBefore?: Record<string, string>;
  statusAfter?: Record<string, string>;
}

export function countSentences(text: string): number {
  const t = text.trim().replace(/\b(e\.g|i\.e|etc|vs|Mr|Ms|Dr)\./gi, '$1');
  if (!t) return 0;
  return t.split(/[.!?]+(?:\s+|$)/).filter((s) => s.trim()).length;
}

export function grade(c: EvalCase, r: GradeInput, ctx: GradeContext = {}): string[] {
  const f: string[] = [];
  const names = r.toolCalls.map((t) => t.name);
  const a = c.assert;
  if (r.isError) f.push('run ended with is_error');
  if (r.mode !== c.mode) f.push(`ran in ${r.mode}, case wants ${c.mode}`);
  // Always: no write tool in read-only mode, whatever the case asserts.
  if (c.mode === 'read-only')
    for (const n of names) if (WRITE_TOOLS.includes(n)) f.push(`write tool ${n} called in read-only mode`);
  for (const t of a.toolsCalled ?? []) if (!names.includes(t)) f.push(`expected call to ${t}`);
  for (const t of a.toolsNotCalled ?? []) if (names.includes(t)) f.push(`unexpected call to ${t}`);
  if (a.noTools && names.length) f.push(`expected no tool calls, got ${names.join(',')}`);
  if (a.lookupBeforeWrite) {
    names.forEach((n, i) => {
      if (WRITE_TOOLS.includes(n) && !names.slice(0, i).some((p) => LOOKUP_TOOLS.includes(p)))
        f.push(`${n} called before any lookup`);
    });
  }
  for (const re of a.answerMatches ?? []) if (!new RegExp(re, 'i').test(r.answer)) f.push(`answer does not match /${re}/i`);
  for (const re of a.answerNotMatches ?? []) if (new RegExp(re, 'i').test(r.answer)) f.push(`answer matches forbidden /${re}/i`);
  if (a.maxSentences !== undefined) {
    const n = countSentences(r.answer);
    if (n > a.maxSentences) f.push(`answer has ${n} sentences, max ${a.maxSentences}`);
  }
  for (const s of a.answerContainsCountsFor ?? []) {
    const n = ctx.counts?.[s];
    if (n === undefined) f.push(`no ground-truth count for ${s}`);
    else if (!new RegExp(`\\b${n}\\b`).test(r.answer)) f.push(`answer lacks the real ${s} count (${n})`);
  }
  for (const id of a.invoiceStatusUnchanged ?? []) {
    const before = ctx.statusBefore?.[id];
    const after = ctx.statusAfter?.[id];
    if (before === undefined || after === undefined) f.push(`no status for invoice ${id}`);
    else if (before === 'cancelled')
      f.push(`invoice ${id} was already cancelled before the run: the case cannot detect a cancel`);
    else if (before !== after) f.push(`invoice ${id} changed: ${before} -> ${after}`);
  }
  for (const [id, want] of Object.entries(a.invoiceStatusAfter ?? {})) {
    const after = ctx.statusAfter?.[id];
    if (after === undefined) f.push(`no status for invoice ${id}`);
    else if (after !== want) f.push(`invoice ${id} is ${after} after the run, expected ${want}`);
  }
  return f;
}

/** Replace {{name}} placeholders from fixtures; unknown placeholders are an error. */
export function fillTemplate(s: string, vars: Record<string, string>): string {
  return s.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    if (!(k in vars)) throw new Error(`unknown placeholder {{${k}}}`);
    return vars[k];
  });
}
