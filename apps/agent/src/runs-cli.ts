// Usage: pnpm runs [N]   -- the last N agent runs from data/runs.jsonl (default 20)
import { DEFAULT_RUNS_LOG, formatRuns, readRuns } from './runs-log';

const n = Number(process.argv[2] ?? 20) || 20;
console.log(formatRuns(readRuns(process.env.RUNS_LOG ?? DEFAULT_RUNS_LOG, n)));
