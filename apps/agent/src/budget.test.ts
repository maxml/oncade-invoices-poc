/**
 * The budget ledger and its lock, tested directly (runAgent's view of it is in run-agent.test.ts).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetExceededError, BudgetLedgerError, reserveBudget, takeOver, withLedgerLock, type BudgetFiles } from './budget';
import { appendRun } from './runs-log';

const NOW = new Date('2026-11-18T12:00:00Z');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function files(): BudgetFiles & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'runs-ledger-'));
  dirs.push(dir);
  return { dir, runsLog: join(dir, 'runs.jsonl'), ledger: join(dir, 'budget-reservations.json') };
}
const reserve = (f: BudgetFiles, id = 'r1', amountUsd = 0.5, capUsd = 2) => reserveBudget(f, { id, amountUsd, capUsd, now: NOW });
const ledgerOf = (f: BudgetFiles) => JSON.parse(readFileSync(f.ledger, 'utf8')).reservations as { id: string }[];
const entry = (over: Record<string, unknown>) => ({ id: 'x', ts: NOW.toISOString(), amountUsd: 0.5, pid: 1, ...over });
/** A pid that belonged to a process that has exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;

describe('reserveBudget fails closed on ledger I/O errors (BudgetLedgerError, with the reason)', () => {
  it('the ledger folder cannot be created', () => {
    const f = files();
    writeFileSync(join(f.dir, 'a-file'), '');
    const err = (() => {
      try {
        return reserve({ ...f, ledger: join(f.dir, 'a-file', 'sub', 'ledger.json') });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BudgetLedgerError);
    expect((err as Error).message).toMatch(/Budget ledger folder .*a-file\/sub is not writable \(ENOTDIR\); no run started/);
  });

  it('the ledger cannot be read', () => {
    const f = files();
    writeFileSync(f.ledger, '{ not json');
    expect(() => reserve(f)).toThrow(BudgetLedgerError);
    expect(() => reserve(f)).toThrow(/Cannot read the budget ledger .*budget-reservations\.json/);
    expect(readFileSync(f.ledger, 'utf8')).toBe('{ not json'); // not overwritten
  });

  it('the ledger cannot be written', () => {
    const f = files();
    // The temp file the ledger is written through is a directory: reading works, writing does not.
    mkdirSync(`${f.ledger}.${process.pid}.tmp`);
    expect(() => reserve(f)).toThrow(BudgetLedgerError);
    expect(() => reserve(f)).toThrow(/Cannot write the budget ledger .*budget-reservations\.json \(EISDIR\); no run started/);
    expect(existsSync(f.ledger)).toBe(false);
    expect(existsSync(`${f.ledger}.lock`)).toBe(false);
  });
});

describe('reserveBudget validates every ledger entry', () => {
  it.each([
    ['amount as a string', entry({ amountUsd: '0.6' })],
    ['negative amount', entry({ amountUsd: -5 })],
    ['null amount', entry({ amountUsd: null })],
    ['infinite amount (JSON 1e999)', 'INF'],
    ['missing ts', entry({ ts: undefined })],
    ['ts that is not a date', entry({ ts: 'yesterday' })],
    ['missing id', entry({ id: undefined })],
    ['entry that is not an object', 42],
  ])('an entry with %s: no run (fail closed), the ledger is left as it was', (_, bad) => {
    const f = files();
    const raw =
      bad === 'INF'
        ? `{"reservations":[{"id":"x","ts":"${NOW.toISOString()}","amountUsd":1e999,"pid":1}]}`
        : JSON.stringify({ reservations: [bad] });
    writeFileSync(f.ledger, raw);
    expect(() => reserve(f)).toThrow(BudgetLedgerError);
    expect(readFileSync(f.ledger, 'utf8')).toBe(raw);
  });

  it('a valid ledger from another process still works (control)', () => {
    const f = files();
    writeFileSync(f.ledger, JSON.stringify({ reservations: [entry({ id: 'other', amountUsd: 0.6 })] }));
    expect(reserve(f)).toEqual({ spentUsd: 0, reservedUsd: 0.6 });
    expect(ledgerOf(f).map((x) => x.id)).toEqual(['other', 'r1']);
  });

  it('prunes entries from earlier days, keeps and counts entries dated later than now (clock skew)', () => {
    const f = files();
    const yesterday = entry({ id: 'yesterday', ts: '2026-11-17T23:59:59.000Z', amountUsd: 1 });
    const tomorrow = entry({ id: 'tomorrow', ts: '2026-11-19T00:00:01.000Z', amountUsd: 1 });
    writeFileSync(f.ledger, JSON.stringify({ reservations: [yesterday, tomorrow] }));
    // Cap 2: tomorrow's 1 + 0.5 fits; yesterday's does not count.
    expect(reserve(f)).toEqual({ spentUsd: 0, reservedUsd: 1 });
    expect(ledgerOf(f).map((x) => x.id)).toEqual(['tomorrow', 'r1']);
    // Now 1.5 is held: another 0.6 does not fit.
    expect(() => reserve(f, 'r2', 0.6)).toThrow(BudgetExceededError);
  });
});

describe('the ledger lock', () => {
  it('release removes the lock only while it still holds this holder token', () => {
    const f = files();
    const lock = `${f.ledger}.lock`;
    withLedgerLock(f.ledger, {}, () => {
      expect(existsSync(lock)).toBe(true);
      writeFileSync(lock, '12345 someone-else'); // our lock was replaced while we held it
    });
    expect(readFileSync(lock, 'utf8')).toBe('12345 someone-else');
    // A lock that is still ours is removed.
    rmSync(lock);
    withLedgerLock(f.ledger, {}, () => undefined);
    expect(existsSync(lock)).toBe(false);
  });

  it('a lock held by a live process is never taken over, however old', () => {
    const f = files();
    const lock = `${f.ledger}.lock`;
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
    try {
      writeFileSync(lock, `${holder.pid} live-holder`);
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(lock, old, old);
      expect(() => withLedgerLock(f.ledger, { waitMs: 50, staleMs: 1 }, () => 'ran')).toThrow(/locked by another process/);
      expect(readFileSync(lock, 'utf8')).toBe(`${holder.pid} live-holder`);
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it('a lock left by a dead process is taken over once it is older than staleMs', () => {
    const f = files();
    const lock = `${f.ledger}.lock`;
    writeFileSync(lock, `${deadPid()} dead-holder`);
    expect(() => withLedgerLock(f.ledger, { waitMs: 50, staleMs: 60_000 }, () => 'ran')).toThrow(/locked/);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(withLedgerLock(f.ledger, { waitMs: 50, staleMs: 60_000 }, () => 'ran')).toBe('ran');
    expect(readdirSync(f.dir)).toEqual([]);
  });

  it('takeover replaces only the exact dead lock it judged, and only one taker wins it', () => {
    const f = files();
    const lock = `${f.ledger}.lock`;
    const tmp = join(f.dir, 'mine.tmp');
    writeFileSync(tmp, `${process.pid} mine`);
    // Another taker already replaced the dead lock with its own: we must not overwrite it.
    writeFileSync(lock, '222 winner');
    expect(takeOver(lock, '111 dead', tmp)).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe('222 winner');
    // Another taker is in the middle of taking over this same dead lock (holds its reap file).
    writeFileSync(lock, '111 dead');
    const reap = `${lock}.reap-${createHash('sha256').update('111 dead').digest('hex').slice(0, 16)}`;
    writeFileSync(reap, '333');
    expect(takeOver(lock, '111 dead', tmp)).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe('111 dead');
    expect(readFileSync(reap, 'utf8')).toBe('333'); // its reap file is not ours to remove
    rmSync(reap);
    const others = readdirSync(f.dir);
    expect(takeOver(lock, '111 dead', tmp)).toBe(true); // control: alone, we win
    expect(readFileSync(lock, 'utf8')).toBe(`${process.pid} mine`);
    expect(readdirSync(f.dir).sort()).toEqual(others.sort()); // no reap or copy file left
  });

  /**
   * Real processes against one ledger, with a dead process's lock left behind and staleMs = 1 ms,
   * so a takeover is always on the table. Every accepted reservation must be in the ledger, and no
   * more may be accepted than the cap allows.
   */
  it('separate processes: no lost reservation, never over the cap', async () => {
    const f = files();
    const CHILDREN = 8;
    const PER_CHILD = 6;
    const CAP = 30; // each reservation is $1: 48 attempts, room for 30
    writeFileSync(`${f.ledger}.lock`, `${deadPid()} dead-holder`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${f.ledger}.lock`, old, old);
    appendRun(f.runsLog, { ...RUN, ts: NOW.toISOString(), costUsd: 0 });

    const go = join(f.dir, 'go');
    const child = join(f.dir, 'child.mjs');
    writeFileSync(
      child,
      `import { existsSync } from 'node:fs';
import { reserveBudget, BudgetExceededError } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, 'budget.ts')).href)};
const [runsLog, ledger, go, n, cap, now] = process.argv.slice(2);
process.stdout.write('ready\\n');
while (!existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
const out = { accepted: [], refused: 0, errors: [] };
for (let i = 0; i < Number(n); i++) {
  const id = process.pid + '-' + i;
  try {
    reserveBudget({ runsLog, ledger, lock: { waitMs: 10000, staleMs: 1 } }, { id, amountUsd: 1, capUsd: Number(cap), now: new Date(now) });
    out.accepted.push(id);
  } catch (e) {
    if (e instanceof BudgetExceededError) out.refused++;
    else out.errors.push(String(e));
  }
}
process.stdout.write(JSON.stringify(out) + '\\n');
`,
    );
    const repo = resolve(import.meta.dirname, '../../..');
    const procs = Array.from({ length: CHILDREN }, () => {
      const p = spawn(
        process.execPath,
        ['--import', 'tsx', child, f.runsLog, f.ledger, go, String(PER_CHILD), String(CAP), NOW.toISOString()],
        { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      const ready = new Promise<void>((ok) => p.stdout.on('data', () => out.includes('ready') && ok()));
      const done = new Promise<{ code: number | null; out: string; err: string }>((ok) =>
        p.on('close', (code) => ok({ code, out, err })),
      );
      return { ready, done };
    });
    await Promise.all(procs.map((p) => p.ready));
    writeFileSync(go, '');
    const results = await Promise.all(procs.map((p) => p.done));

    const parsed = results.map((r) => {
      expect(r.code, r.err).toBe(0);
      return JSON.parse(r.out.split('\n').filter(Boolean).at(-1)!) as {
        accepted: string[];
        refused: number;
        errors: string[];
      };
    });
    const accepted = parsed.flatMap((p) => p.accepted);
    expect(parsed.flatMap((p) => p.errors)).toEqual([]);
    expect(accepted.length, 'accepted reservations').toBe(CAP);
    expect(parsed.reduce((s, p) => s + p.refused, 0)).toBe(CHILDREN * PER_CHILD - CAP);
    expect(
      ledgerOf(f)
        .map((x) => x.id)
        .sort(),
      'ledger entries == accepted reservations',
    ).toEqual([...accepted].sort());
    // No lock or helper files left behind.
    expect(readdirSync(f.dir).sort()).toEqual(['budget-reservations.json', 'child.mjs', 'go', 'runs.jsonl']);
  }, 15_000);
});

const RUN = {
  runId: 'r',
  source: 'test',
  mode: 'read-only' as const,
  promptVersion: 'v1',
  promptSha256: 'x',
  model: 'm',
  toolsCalled: [],
  isError: false,
  timedOut: false,
  sandboxed: false,
};
