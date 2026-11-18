/**
 * One JSON line per agent run in data/runs.jsonl, the reader behind `pnpm runs`, and the daily
 * budget: a reservation ledger next to the runs log, shared by every process through a lock file.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
  /** True when the run reported no cost (crash, timeout, no result) and costUsd is the full reservation. */
  costEstimated?: boolean;
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

/** Sum of `costUsd` of the runs logged on the same UTC day as `now`. */
export function spentToday(file: string, now: Date): number {
  const day = now.toISOString().slice(0, 10);
  return readRuns(file, Infinity)
    .filter((r) => r.ts.slice(0, 10) === day)
    .reduce((s, r) => s + (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) ? r.costUsd : 0), 0);
}

export class BudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly capUsd: number,
    readonly reservedUsd = 0,
    readonly neededUsd = 0,
  ) {
    super(
      `Daily agent budget of $${capUsd.toFixed(2)} reached: $${spentUsd.toFixed(2)} spent today (UTC), ` +
        `$${reservedUsd.toFixed(2)} reserved by runs in progress, and a run reserves up to $${neededUsd.toFixed(2)} ` +
        '(AGENT_MAX_BUDGET_USD). Raise AGENT_DAILY_BUDGET_USD in .env or try again tomorrow.',
    );
  }
}

/** The ledger could not be locked, read or written: no run starts (fail closed). */
export class BudgetLedgerError extends Error {}

/** A run in flight: its maximum cost, held against the daily cap until the real cost is logged. */
export interface Reservation {
  id: string;
  ts: string;
  amountUsd: number;
  pid: number;
}

export interface LockOptions {
  /** How long to wait for another process's lock. Default 5 s. */
  waitMs?: number;
  /** A lock file older than this is from a dead process and is taken over. Default 30 s. */
  staleMs?: number;
}

export interface BudgetFiles {
  runsLog: string;
  /** JSON `{ reservations: Reservation[] }`. Default: budget-reservations.json next to the runs log. */
  ledger: string;
  lock?: LockOptions;
}

/**
 * Next to the runs log, i.e. under data/, which is read-only inside the sandbox. Not data/state:
 * that folder is writable by the sandboxed agent's MCP server.
 */
export const defaultLedger = (runsLog: string) => join(dirname(runsLog), 'budget-reservations.json');

const code = (e: unknown) => (e as { code?: string })?.code ?? String(e);
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run `fn` holding `<ledger>.lock` (created with O_EXCL); a stale lock is taken over. */
function withLock<T>(ledger: string, o: LockOptions, fn: () => T): T {
  const lock = `${ledger}.lock`;
  const waitMs = o.waitMs ?? 5_000;
  const staleMs = o.staleMs ?? 30_000;
  try {
    mkdirSync(dirname(ledger), { recursive: true });
  } catch (e) {
    throw new BudgetLedgerError(`Budget ledger folder ${dirname(ledger)} is not writable (${code(e)}); no run started.`);
  }
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if (code(e) !== 'EEXIST')
        throw new BudgetLedgerError(`Cannot create the budget lock ${lock} (${code(e)}); no run started.`);
    }
    let age: number;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // released in between
    }
    if (age > staleMs) {
      try {
        unlinkSync(lock);
      } catch {
        // someone else took it over first
      }
      continue;
    }
    if (Date.now() - started > waitMs)
      throw new BudgetLedgerError(`Budget ledger is locked by another process (${lock}); no run started. Try again.`);
    sleepSync(10);
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}

function readReservations(ledger: string): Reservation[] {
  if (!existsSync(ledger)) return [];
  const v = JSON.parse(readFileSync(ledger, 'utf8')) as { reservations?: unknown };
  if (!Array.isArray(v?.reservations)) throw new Error('no reservations array');
  return v.reservations as Reservation[];
}

function writeReservations(ledger: string, rs: Reservation[]): void {
  const tmp = `${ledger}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ reservations: rs }, null, 2) + '\n');
  renameSync(tmp, ledger);
}

const sameDay = (ts: string, now: Date) => ts.slice(0, 10) === now.toISOString().slice(0, 10);

/**
 * Before a run: under the lock, refuse unless spent today + reserved by runs in flight + this
 * reservation fits the cap, then record the reservation. Fails closed (BudgetLedgerError) when the
 * runs log or the ledger cannot be written, so a run never starts without a way to count its cost.
 * A reservation whose process died stays in the ledger and counts for its day.
 */
export function reserveBudget(
  f: BudgetFiles,
  r: { id: string; amountUsd: number; capUsd: number; now: Date },
): { spentUsd: number; reservedUsd: number } {
  return withLock(f.ledger, f.lock ?? {}, () => {
    try {
      mkdirSync(dirname(f.runsLog), { recursive: true });
      appendFileSync(f.runsLog, '');
    } catch (e) {
      throw new BudgetLedgerError(
        `The runs log ${f.runsLog} is not writable (${code(e)}): no run started, its cost could not be counted.`,
      );
    }
    let spent: number;
    let all: Reservation[];
    try {
      spent = spentToday(f.runsLog, r.now);
      all = readReservations(f.ledger);
    } catch (e) {
      throw new BudgetLedgerError(`Cannot read the budget ledger ${f.ledger} (${String(e)}); no run started.`);
    }
    const today = all.filter((x) => typeof x?.ts === 'string' && sameDay(x.ts, r.now));
    const reserved = today.reduce((s, x) => s + (Number.isFinite(x.amountUsd) ? x.amountUsd : 0), 0);
    if (spent + reserved + r.amountUsd > r.capUsd) throw new BudgetExceededError(spent, r.capUsd, reserved, r.amountUsd);
    try {
      writeReservations(f.ledger, [...today, { id: r.id, ts: r.now.toISOString(), amountUsd: r.amountUsd, pid: process.pid }]);
    } catch (e) {
      throw new BudgetLedgerError(`Cannot write the budget ledger ${f.ledger} (${code(e)}); no run started.`);
    }
    return { spentUsd: spent, reservedUsd: reserved };
  });
}

/**
 * After a run: under the lock, append its record (with the real or the estimated cost) and only
 * then drop its reservation. If either step fails the reservation stays, so the cost still counts.
 */
export function settleBudget(f: BudgetFiles, reservationId: string, rec: RunRecord): void {
  withLock(f.ledger, f.lock ?? {}, () => {
    appendRun(f.runsLog, rec);
    writeReservations(
      f.ledger,
      readReservations(f.ledger).filter((x) => x?.id !== reservationId),
    );
  });
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
      r.costUsd === undefined ? '$?' : r.costEstimated ? `~$${r.costUsd.toFixed(4)} (estimated)` : `$${r.costUsd.toFixed(4)}`,
      r.sandboxed ? 'bwrap' : 'no-sandbox',
      r.toolsCalled.join(',') || '-',
    ].join('  '),
  );
  return rows.join('\n') || '(no runs yet)';
}
