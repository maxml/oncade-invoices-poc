/** One JSON line per agent run in data/runs.jsonl, and the reader behind `pnpm runs`. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const DEFAULT_RUNS_LOG = resolve(import.meta.dirname, '../../../data/runs.jsonl');

export interface RunRecord {
  ts: string;
  runId: string;
  source: string;
  mode: 'read-only' | 'allow-changes';
  promptVersion: string;
  promptSha256: string;
  model: string;
  toolsCalled: string[];
  isError: boolean;
  timedOut: boolean;
  numTurns?: number;
  durationMs?: number;
  costUsd?: number;
  sandboxed: boolean;
}

export function appendRun(file: string, r: RunRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(r) + '\n');
}

/** Last `n` runs, oldest first. Lines that are not valid records are skipped. */
export function readRuns(file: string, n = 20): RunRecord[] {
  if (!existsSync(file)) return [];
  const out: RunRecord[] = [];
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      if (r && typeof r.runId === 'string' && typeof r.ts === 'string' && Array.isArray(r.toolsCalled)) out.push(r);
    } catch {
      // skip a torn line
    }
  }
  return out.slice(-n);
}

export function formatRuns(runs: RunRecord[]): string {
  const rows = runs.map((r) =>
    [
      r.ts.slice(0, 19).replace('T', ' '),
      r.source,
      r.mode,
      r.promptVersion,
      r.model,
      r.isError ? (r.timedOut ? 'TIMEOUT' : 'ERROR') : 'ok',
      `${r.durationMs ?? '?'}ms`,
      r.costUsd === undefined ? '$?' : `$${r.costUsd.toFixed(4)}`,
      r.sandboxed ? 'bwrap' : 'no-sandbox',
      r.toolsCalled.join(',') || '-',
    ].join('  '),
  );
  return rows.join('\n') || '(no runs yet)';
}
