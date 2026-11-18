import { describe, expect, it, vi } from 'vitest';
import { askCommand } from './ask';
import type { AgentResult } from './run-agent';
import { BudgetExceededError, BudgetLedgerError } from './budget';

const result = (over: Partial<AgentResult> = {}): AgentResult => ({
  answer: 'Done',
  toolCalls: [],
  isError: false,
  timedOut: false,
  sandboxed: true,
  runId: 'r',
  mode: 'read-only',
  model: 'm',
  promptVersion: 'v4',
  costUsd: 0.01,
  ...over,
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, write: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

describe('pnpm ask', () => {
  it('passes --allow-changes through and prints the answer', async () => {
    const runAgent = vi.fn(async () => result({ mode: 'allow-changes' }));
    const o = io();
    expect(await askCommand(['--allow-changes', 'Cancel', 'INV-2026-1234567'], { runAgent, ...o.write })).toBe(0);
    expect(runAgent).toHaveBeenCalledWith('Cancel INV-2026-1234567', { allowChanges: true, source: 'cli' });
    expect(o.out.join('')).toContain('Done');
  });

  it('over the daily budget: exits 3 with a message, not a stack trace', async () => {
    const runAgent = vi.fn(async () => {
      throw new BudgetExceededError(2.01, 2);
    });
    const o = io();
    expect(await askCommand(['list invoices'], { runAgent, ...o.write })).toBe(3);
    expect(o.err.join('')).toMatch(/Daily agent budget of \$2\.00 reached/);
    expect(o.out).toEqual([]);
  });

  it('budget ledger unavailable: exits 3 with the reason, not a stack trace', async () => {
    const runAgent = vi.fn(async () => {
      throw new BudgetLedgerError('Budget ledger is locked by another process (/x.lock); no run started. Try again.');
    });
    const o = io();
    expect(await askCommand(['list invoices'], { runAgent, ...o.write })).toBe(3);
    expect(o.err.join('')).toBe('Budget ledger is locked by another process (/x.lock); no run started. Try again.\n');
    expect(o.out).toEqual([]);
  });

  it('other errors are not swallowed as a budget refusal', async () => {
    const runAgent = vi.fn(async () => {
      throw new Error('boom');
    });
    const o = io();
    await expect(askCommand(['list invoices'], { runAgent, ...o.write })).rejects.toThrow('boom');
  });

  it('without a question prints usage and exits 2', async () => {
    const o = io();
    expect(await askCommand([], { runAgent: vi.fn(), ...o.write })).toBe(2);
    expect(o.err.join('')).toMatch(/Usage/);
  });
});
