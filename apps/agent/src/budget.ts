/**
 * The daily agent budget: a reservation ledger next to the runs log, shared by every process
 * through a lock file. The spend side comes from the runs log (runs-log.ts).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { appendRun, readRuns, type RunRecord } from './runs-log';

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

/** Whether the process that wrote a lock (`"<pid> <token>"`) may still be running. */
function holderAlive(content: string): boolean {
  const pid = Number(content.split(' ')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false; // torn or foreign content: judged by age only
  // Locks are taken and released synchronously, so a lock with our own pid that we are not holding
  // was left by an earlier process that had the same pid.
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return code(e) === 'EPERM'; // exists, owned by another user
  }
}

const readOrNull = (f: string) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};

/**
 * Run `fn` holding `<ledger>.lock`. The lock file holds `"<pid> <token>"` with a token unique to
 * this acquisition; it is created whole and atomically (written to a temp file, then `link`ed,
 * which fails if the lock exists).
 *
 * A lock is taken over only when its holder process is gone AND it is older than `staleMs`; a
 * live holder is waited for, then refused (fail closed). Two processes that both find the same
 * dead lock: each must first create `<lock>.reap-<hash of its content>` with O_EXCL, so only one
 * can replace it; the winner re-reads the lock and replaces it (atomic `rename` of its own fresh
 * lock) only if it still holds that same content. Release removes the lock only if it still holds
 * our token.
 */
function withLock<T>(ledger: string, o: LockOptions, fn: () => T): T {
  const lock = `${ledger}.lock`;
  const waitMs = o.waitMs ?? 5_000;
  const staleMs = o.staleMs ?? 30_000;
  try {
    mkdirSync(dirname(ledger), { recursive: true });
  } catch (e) {
    throw new BudgetLedgerError(`Budget ledger folder ${dirname(ledger)} is not writable (${code(e)}); no run started.`);
  }
  const mine = `${process.pid} ${randomUUID()}`;
  const tmp = `${lock}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, mine, { flag: 'wx' });
  } catch (e) {
    throw new BudgetLedgerError(`Cannot create the budget lock ${lock} (${code(e)}); no run started.`);
  }
  const started = Date.now();
  try {
    for (;;) {
      try {
        linkSync(tmp, lock);
        break;
      } catch (e) {
        if (code(e) !== 'EEXIST')
          throw new BudgetLedgerError(`Cannot create the budget lock ${lock} (${code(e)}); no run started.`);
      }
      const seen = readOrNull(lock);
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released in between
      }
      if (seen !== null && age > staleMs && !holderAlive(seen) && takeOver(lock, seen, tmp)) break;
      if (Date.now() - started > waitMs)
        throw new BudgetLedgerError(
          `Budget ledger is locked by another process (${lock}); no run started. Try again; if no agent run is ` +
            'in progress and this persists, remove that file.',
        );
      sleepSync(5);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  try {
    return fn();
  } finally {
    if (readOrNull(lock) === mine) rmSync(lock, { force: true });
  }
}

/** Replace the dead lock whose content is `seen` with ours (`tmp`); true when we now hold it. */
export function takeOver(lock: string, seen: string, tmp: string): boolean {
  const reap = `${lock}.reap-${createHash('sha256').update(seen).digest('hex').slice(0, 16)}`;
  try {
    writeFileSync(reap, String(process.pid), { flag: 'wx' });
  } catch {
    return false; // another process is taking over this same dead lock
  }
  try {
    if (readOrNull(lock) !== seen) return false; // already replaced or released
    // `tmp` must stay for the caller's cleanup and retries, so rename a copy of it.
    const copy = `${tmp}.takeover`;
    writeFileSync(copy, readFileSync(tmp));
    renameSync(copy, lock);
    return true;
  } finally {
    rmSync(reap, { force: true });
  }
}

export const withLedgerLock = withLock;

const ReservationSchema = z.object({
  id: z.string().min(1),
  ts: z.iso.datetime(),
  amountUsd: z.number().nonnegative(), // z.number() rejects NaN and Infinity
  pid: z.number().int(),
});
const LedgerSchema = z.object({ reservations: z.array(ReservationSchema) });

/** The ledger, every entry validated: anything malformed throws, and the caller refuses the run. */
function readReservations(ledger: string): Reservation[] {
  if (!existsSync(ledger)) return [];
  const v = LedgerSchema.safeParse(JSON.parse(readFileSync(ledger, 'utf8')));
  if (!v.success) throw new Error(`invalid ledger: ${v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return v.data.reservations;
}

function writeReservations(ledger: string, rs: Reservation[]): void {
  const tmp = `${ledger}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ reservations: rs }, null, 2) + '\n');
  renameSync(tmp, ledger);
}

/**
 * Entries of today or later (UTC day) stay and count. Only earlier days are pruned: a reservation
 * dated in the future comes from a process whose clock runs ahead, and is still a run in flight.
 */
const notBeforeToday = (ts: string, now: Date) => ts.slice(0, 10) >= now.toISOString().slice(0, 10);

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
    const today = all.filter((x) => notBeforeToday(x.ts, r.now));
    const reserved = today.reduce((s, x) => s + x.amountUsd, 0);
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
      readReservations(f.ledger).filter((x) => x.id !== reservationId),
    );
  });
}
