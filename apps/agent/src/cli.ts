// Usage: pnpm ask "List my last 5 invoices"
import { loadEnv } from '../../server/src/env';
import { runAgent } from './run-agent';

loadEnv();
const prompt = process.argv.slice(2).join(' ').trim();
if (!prompt) {
  console.error('Usage: pnpm ask "<question about your invoices>"');
  process.exit(2);
}
const r = await runAgent(prompt);
console.log(r.answer);
console.error(`\n[tools] ${r.toolCalls.map((t) => t.name).join(', ') || 'none'}  [sandboxed] ${r.sandboxed}  [cost] $${r.costUsd?.toFixed(4) ?? '?'}`);
process.exit(r.isError ? 1 : 0);
