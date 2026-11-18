// Usage: pnpm ask [--allow-changes] "List my last 5 invoices"
// Read-only by default: without --allow-changes the agent has no create/send/cancel tools.
import { loadEnv } from '../../server/src/env';
import { runAgent } from './run-agent';

loadEnv();
const argv = process.argv.slice(2);
const allowChanges = argv.includes('--allow-changes');
const prompt = argv.filter((a) => a !== '--allow-changes').join(' ').trim();
if (!prompt) {
  console.error('Usage: pnpm ask [--allow-changes] "<question about your invoices>"');
  process.exit(2);
}
const r = await runAgent(prompt, { allowChanges, source: 'cli' });
console.log(r.answer);
console.error(
  `\n[mode] ${r.mode}  [tools] ${r.toolCalls.map((t) => t.name).join(', ') || 'none'}  [sandboxed] ${r.sandboxed}  [prompt] ${r.promptVersion}  [cost] $${r.costUsd?.toFixed(4) ?? '?'}`,
);
process.exit(r.isError ? 1 : 0);
