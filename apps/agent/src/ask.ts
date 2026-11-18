/** `pnpm ask [--allow-changes] "<question>"`: one agent turn from the terminal. Returns the exit code. */
import type { AgentOptions, AgentResult } from './run-agent';
import { BudgetExceededError } from './runs';

export interface AskDeps {
  runAgent: (prompt: string, opts: AgentOptions) => Promise<AgentResult>;
  out: (s: string) => void;
  err: (s: string) => void;
}

export async function askCommand(argv: string[], d: AskDeps): Promise<number> {
  // Read-only by default: without --allow-changes the agent has no create/send/cancel tools.
  const allowChanges = argv.includes('--allow-changes');
  const prompt = argv
    .filter((a) => a !== '--allow-changes')
    .join(' ')
    .trim();
  if (!prompt) {
    d.err('Usage: pnpm ask [--allow-changes] "<question about your invoices>"\n');
    return 2;
  }
  let r: AgentResult;
  try {
    r = await d.runAgent(prompt, { allowChanges, source: 'cli' });
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      d.err(`${e.message}\n`);
      return 3;
    }
    throw e;
  }
  d.out(`${r.answer}\n`);
  d.err(
    `\n[mode] ${r.mode}  [tools] ${r.toolCalls.map((t) => t.name).join(', ') || 'none'}  [sandboxed] ${r.sandboxed}  [prompt] ${r.promptVersion}  [cost] $${r.costUsd?.toFixed(4) ?? '?'}\n`,
  );
  return r.isError ? 1 : 0;
}
