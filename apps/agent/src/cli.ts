// Usage: pnpm ask [--allow-changes] "List my last 5 invoices"
import { loadEnv } from '../../server/src/env';
import { askCommand } from './ask';
import { runAgent } from './run-agent';

loadEnv();
const code = await askCommand(process.argv.slice(2), {
  runAgent,
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
});
process.exit(code);
