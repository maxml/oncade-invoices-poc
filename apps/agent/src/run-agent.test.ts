import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, appendFileSync, readFileSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../../packages/config/src/config';
import { agentMode, bwrapArgs, ETC_FILES, mcpConfig, parseAgentStream, runAgent, type SandboxInput } from './run-agent';
import { appendRun, BudgetExceededError, BudgetLedgerError, formatRuns, readRuns, spentToday, type RunRecord } from './runs';

describe('parseAgentStream', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' }),
    'not json at all',
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Looking up' },
          { type: 'tool_use', name: 'mcp__oncade__list_invoices', input: { limit: 5 } },
        ],
      },
    }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'mcp__oncade__get_invoice', input: { invoiceId: 'a' } }] },
    }),
    JSON.stringify({ type: 'assistant', message: { content: null } }),
    'null',
    JSON.stringify({ type: 'result', result: 'Done', is_error: false, total_cost_usd: 0.01, duration_ms: 900, num_turns: 3 }),
  ];

  it('collects tool calls in order without the MCP prefix, the result event and the model', () => {
    const p = parseAgentStream(lines);
    expect(p.toolCalls).toEqual([
      { name: 'list_invoices', input: { limit: 5 } },
      { name: 'get_invoice', input: { invoiceId: 'a' } },
    ]);
    expect(p.final).toMatchObject({ result: 'Done', num_turns: 3 });
    expect(p.model).toBe('claude-sonnet-4-6');
  });

  it('never throws and returns no final event for garbage or a truncated stream', () => {
    expect(parseAgentStream(['{', '[]', '42', '"s"', ''])).toEqual({ toolCalls: [] });
    expect(parseAgentStream(lines.slice(0, 3)).final).toBeUndefined();
  });
});

describe('bwrapArgs', () => {
  const base: SandboxInput = {
    claudeBin: '/home/u/.local/bin/claude',
    claudeReal: '/home/u/.local/share/claude/versions/1',
    nodeRoot: '/home/u/.nvm/versions/node/v24',
    workDir: '/tmp/oncade-agent-x',
    home: '/home/u',
    root: '/repo',
    resolvConf: '/run/systemd/resolve/stub-resolv.conf',
    env: {},
    exists: () => true,
  };
  const binds = (a: string[]) => {
    const out: { kind: string; src: string; dst: string }[] = [];
    for (let i = 0; i < a.length; i++)
      if (a[i] === '--bind' || a[i] === '--ro-bind') out.push({ kind: a[i], src: a[i + 1], dst: a[i + 2] });
    return out;
  };

  it('does not bind /etc wholesale, only the listed files plus resolv.conf', () => {
    const b = binds(bwrapArgs(base));
    expect(b.find((x) => x.dst === '/etc')).toBeUndefined();
    const etc = b.filter((x) => x.dst.startsWith('/etc')).map((x) => x.dst);
    expect(etc.sort()).toEqual([...ETC_FILES, '/etc/resolv.conf'].sort());
    expect(b).toContainEqual({ kind: '--ro-bind', src: base.resolvConf, dst: '/etc/resolv.conf' });
  });

  it('with ANTHROPIC_API_KEY binds nothing from $HOME', () => {
    const b = binds(bwrapArgs({ ...base, env: { ANTHROPIC_API_KEY: 'sk-test' } }));
    expect(
      b.filter((x) => x.src.startsWith('/home/u/') && !x.src.startsWith('/home/u/.nvm') && !x.src.startsWith('/home/u/.local')),
    ).toEqual([]);
    expect(b.some((x) => x.src.includes('.credentials.json'))).toBe(false);
  });

  it('without an API key binds only the credentials file from ~/.claude (read-write, for token refresh)', () => {
    const b = binds(bwrapArgs(base)).filter((x) => x.src.includes('/.claude/'));
    expect(b).toEqual([{ kind: '--bind', src: '/home/u/.claude/.credentials.json', dst: '/home/u/.claude/.credentials.json' }]);
  });

  it('code and data are read-only; only the work dir and data/state are writable', () => {
    const rw = binds(bwrapArgs(base))
      .filter((x) => x.kind === '--bind')
      .map((x) => x.dst);
    expect(rw.sort()).toEqual(['/home/u/.claude/.credentials.json', '/repo/data/state', '/tmp/oncade-agent-x'].sort());
  });
});

describe('mcpConfig', () => {
  it('passes the mode and run id to the MCP server through its env', () => {
    expect(mcpConfig({ readOnly: true, runId: 'r1' }).mcpServers.oncade.env).toEqual({
      ONCADE_READ_ONLY: '1',
      ONCADE_RUN_ID: 'r1',
      ONCADE_ALLOWED_INVOICES: '',
      ONCADE_ALLOWED_EMAILS: '',
      ONCADE_EMAIL_ALLOWED: '0',
    });
    expect(mcpConfig({ readOnly: false, runId: 'r2' }).mcpServers.oncade.env.ONCADE_READ_ONLY).toBe('0');
  });
});

/**
 * runAgent with a fake `claude` process: the test reads the MCP config file and the CLI args
 * runAgent actually built for the run, so a change to the wiring (not only to a helper) shows up.
 */
describe('runAgent (fake CLI)', () => {
  const env = { ONCADE_API_KEY: 'oncade_platform_test_fake', ONCADE_BUSINESS_ID: 'biz', AGENT_SANDBOX: 'off' };
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setup(extraEnv: Record<string, string> = {}) {
    const d = mkdtempSync(join(tmpdir(), 'run-agent-test-'));
    dirs.push(d);
    const runsLog = join(d, 'runs.jsonl');
    const seen: { args: string[]; mcp: any }[] = [];
    const spawn = vi.fn((_cmd: string, args: string[]) => {
      const mcpFile = args[args.indexOf('--mcp-config') + 1];
      seen.push({ args, mcp: JSON.parse(readFileSync(mcpFile, 'utf8')) });
      const p: any = new EventEmitter();
      p.stdout = new PassThrough();
      p.stderr = new PassThrough();
      p.kill = () => {};
      p.stdout.on('end', () => setImmediate(() => p.emit('close', 0)));
      setImmediate(() => {
        p.stdout.end(
          JSON.stringify({ type: 'result', result: 'Done', is_error: false, total_cost_usd: 0.01, num_turns: 1 }) + '\n',
        );
        p.stderr.end();
      });
      p.stdout.resume();
      return p;
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = {
      config: parseConfig({ ...env, ...extraEnv }),
      spawn: spawn as any,
      which: (bin: string) => (bin === 'claude' ? '/usr/bin/claude' : null),
      runsLog,
      now: () => new Date('2026-11-18T12:00:00Z'),
    };
    return { deps, seen, spawn, runsLog, dir: d };
  }
  const oncadeEnv = (s: { mcp: any }) => s.mcp.mcpServers.oncade.env;

  it.each([[undefined], [false]])(
    'allowChanges=%s: MCP server read-only and write tools disallowed on the CLI',
    async (allowChanges) => {
      const { deps, seen } = setup();
      const r = await runAgent('cancel 6afcec3653040dcf3786bc56', { allowChanges }, deps);
      expect(oncadeEnv(seen[0]).ONCADE_READ_ONLY).toBe('1');
      expect(seen[0].args).toContain('--disallowedTools');
      expect(r.mode).toBe('read-only');
    },
  );

  it('allowChanges=true: MCP server gets ONCADE_READ_ONLY=0 and the CLI disallows nothing', async () => {
    const { deps, seen } = setup();
    const r = await runAgent('list', { allowChanges: true }, deps);
    expect(oncadeEnv(seen[0]).ONCADE_READ_ONLY).toBe('0');
    expect(seen[0].args).not.toContain('--disallowedTools');
    expect(r.mode).toBe('allow-changes');
  });

  it('passes only the invoices named in the request to the MCP server', async () => {
    const { deps, seen } = setup();
    await runAgent('Send INV-2026-8999060, then cancel 6AFCEC3653040DCF3786BC56.', { allowChanges: true }, deps);
    expect(oncadeEnv(seen[0]).ONCADE_ALLOWED_INVOICES).toBe('6afcec3653040dcf3786bc56,INV-2026-8999060');
    await runAgent('Send it.', { allowChanges: true }, deps);
    expect(oncadeEnv(seen[1]).ONCADE_ALLOWED_INVOICES).toBe('');
  });

  it("refuses to start a run when today's spend in the runs log has reached the daily cap", async () => {
    const { deps, spawn, runsLog } = setup({ AGENT_DAILY_BUDGET_USD: '2' });
    const rec = (ts: string, costUsd: number) => appendRun(runsLog, { ...base, ts, costUsd });
    rec('2026-11-17T23:59:59.000Z', 5); // yesterday (UTC): does not count
    rec('2026-11-18T01:00:00.000Z', 1.5);
    await runAgent('q', {}, deps); // 1.5 spent today: still under the cap
    expect(spawn).toHaveBeenCalledTimes(1);
    rec('2026-11-18T02:00:00.000Z', 0.5); // now 2.01 with the run above
    const err = await runAgent('q', {}, deps).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.message).toMatch(/Daily agent budget of \$2\.00 reached: \$2\.01 spent today .*reserves up to \$0\.50/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('passes the email permissions decided from the request text to the MCP server', async () => {
    const { deps, seen } = setup();
    await runAgent('Create a draft for Acme, Billing@Acme.example, $10, and email it to them.', { allowChanges: true }, deps);
    expect(oncadeEnv(seen[0])).toMatchObject({ ONCADE_ALLOWED_EMAILS: 'billing@acme.example', ONCADE_EMAIL_ALLOWED: '1' });
    await runAgent('Create a draft for Acme, billing@acme.example, $10.', { allowChanges: true }, deps);
    expect(oncadeEnv(seen[1])).toMatchObject({ ONCADE_ALLOWED_EMAILS: 'billing@acme.example', ONCADE_EMAIL_ALLOWED: '0' });
    await runAgent('Email billing@acme.example the invoice', {}, deps); // read-only: nothing is allowed
    expect(oncadeEnv(seen[2])).toMatchObject({ ONCADE_ALLOWED_EMAILS: '', ONCADE_EMAIL_ALLOWED: '0' });
  });
});

/**
 * The daily budget is a reservation ledger next to the runs log, shared by every process
 * (`pnpm ask`, the server, `pnpm eval`): a run reserves AGENT_MAX_BUDGET_USD before it starts and
 * the reservation is replaced by the real cost when it ends.
 */
describe('runAgent daily budget (reservation ledger)', () => {
  const env = { ONCADE_API_KEY: 'oncade_platform_test_fake', ONCADE_BUSINESS_ID: 'biz', AGENT_SANDBOX: 'off' };
  const NOW = new Date('2026-11-18T12:00:00Z');
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setup(extraEnv: Record<string, string>, cli: { cost?: number; end?: string; hold?: Promise<void> } = {}) {
    const d = mkdtempSync(join(tmpdir(), 'run-agent-budget-'));
    dirs.push(d);
    const runsLog = join(d, 'runs.jsonl');
    const spawn = vi.fn(() => {
      const p: any = new EventEmitter();
      p.stdout = new PassThrough();
      p.stderr = new PassThrough();
      p.kill = () => p.stdout.end();
      p.stdout.on('end', () => setImmediate(() => p.emit('close', 0)));
      void (cli.hold ?? Promise.resolve()).then(() =>
        setImmediate(() => {
          p.stderr.end();
          if (cli.end === 'hang') return;
          if (cli.end === 'no-result') p.stdout.end(JSON.stringify({ type: 'system', subtype: 'init', model: 'm' }) + '\n');
          else if (cli.end === 'nothing') p.stdout.end();
          else
            p.stdout.end(
              JSON.stringify({ type: 'result', result: 'Done', is_error: false, total_cost_usd: cli.cost ?? 0.01 }) + '\n',
            );
        }),
      );
      p.stdout.resume();
      return p;
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = {
      config: parseConfig({ ...env, ...extraEnv }),
      spawn: spawn as any,
      which: (bin: string) => (bin === 'claude' ? '/usr/bin/claude' : null),
      runsLog,
      now: () => NOW,
    };
    const spend = (costUsd: number) => appendRun(runsLog, { ...base, ts: '2026-11-18T01:00:00.000Z', costUsd });
    return { deps, spawn, runsLog, spend, dir: d, ledger: join(d, 'budget-reservations.json') };
  }

  it('parallel runs near the cap: only as many start as fit, the rest are refused before starting', async () => {
    // Cap $2, each run reserves $0.50, $0.90 spent today: room for exactly two runs.
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { deps, spawn, spend } = setup({ AGENT_DAILY_BUDGET_USD: '2', AGENT_MAX_BUDGET_USD: '0.5' }, { hold });
    spend(0.9);
    const runs = Array.from({ length: 5 }, () =>
      runAgent('q', {}, deps).then(
        () => 'ran',
        (e) => (e instanceof BudgetExceededError ? 'refused' : `other: ${String(e)}`),
      ),
    );
    await new Promise((r) => setImmediate(r));
    expect(spawn, 'CLI processes started while 5 runs were requested at once').toHaveBeenCalledTimes(2);
    release();
    expect((await Promise.all(runs)).sort()).toEqual(['ran', 'ran', 'refused', 'refused', 'refused']);
  });

  it('a reservation another process wrote to the shared ledger file counts against the cap', async () => {
    const { deps, spawn, spend, ledger } = setup({ AGENT_DAILY_BUDGET_USD: '2', AGENT_MAX_BUDGET_USD: '0.5' });
    spend(1);
    // Another process (say `pnpm ask` while the server runs) has a run in flight: 1 + 0.6 + 0.5 > 2.
    writeFileSync(ledger, JSON.stringify({ reservations: [{ id: 'other', ts: NOW.toISOString(), amountUsd: 0.6, pid: 1 }] }));
    const err = await runAgent('q', {}, deps).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.message).toMatch(/\$0\.60 reserved/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('boundary: a run that exactly fills the cap may start; at spent == cap nothing starts', async () => {
    const { deps, spawn, spend } = setup({ AGENT_DAILY_BUDGET_USD: '2', AGENT_MAX_BUDGET_USD: '0.5' }, { cost: 0 });
    spend(1.5); // 1.5 + 0.5 reserved == 2: fits exactly
    await runAgent('q', {}, deps);
    expect(spawn).toHaveBeenCalledTimes(1);
    spend(0.5); // spent == cap
    expect(await runAgent('q', {}, deps).catch((e) => e)).toBeInstanceOf(BudgetExceededError);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each([['no-result'], ['nothing'], ['hang']])(
    'a run that ends without a cost (%s) counts the full reservation as spent, marked costEstimated',
    async (end) => {
      const { deps, runsLog, ledger } = setup(
        { AGENT_DAILY_BUDGET_USD: '2', AGENT_MAX_BUDGET_USD: '0.5', AGENT_TIMEOUT_MS: '1000' },
        { end },
      );
      await runAgent('q', {}, deps).catch(() => undefined);
      const [rec] = readRuns(runsLog);
      expect(rec).toMatchObject({ isError: true, costUsd: 0.5, costEstimated: true });
      // Readers: the budget counts it, `pnpm runs` shows it as an estimate, and the reservation is gone.
      expect(spentToday(runsLog, NOW)).toBe(0.5);
      expect(formatRuns([rec])).toContain('~$0.5000 (estimated)');
      expect(JSON.parse(readFileSync(ledger, 'utf8')).reservations).toEqual([]);
    },
    5_000,
  );

  it('a run with a reported cost records it as exact and releases its reservation', async () => {
    const { deps, runsLog, ledger } = setup({}, { cost: 0.0123 });
    await runAgent('q', {}, deps);
    const [rec] = readRuns(runsLog);
    expect(rec.costUsd).toBe(0.0123);
    expect(rec.costEstimated).toBeUndefined();
    expect(formatRuns([rec])).toContain('$0.0123');
    expect(formatRuns([rec])).not.toContain('estimated');
    expect(JSON.parse(readFileSync(ledger, 'utf8')).reservations).toEqual([]);
  });

  it.each([['runs log'], ['ledger']])('fails closed: refuses before starting when the %s cannot be written', async (which) => {
    const { deps, spawn, dir } = setup({});
    const notADir = join(dir, 'a-file');
    writeFileSync(notADir, '');
    // Only one of the two is broken; the other sits in a writable folder.
    const over =
      which === 'runs log'
        ? { runsLog: join(notADir, 'runs.jsonl'), ledger: join(dir, 'ledger.json') }
        : { ledger: join(notADir, 'ledger.json') };
    const err = await runAgent('q', {}, { ...deps, ...over }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetLedgerError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails closed while another process holds the ledger lock, and takes over a stale lock', async () => {
    const { deps, spawn, ledger } = setup({});
    const lock = `${ledger}.lock`;
    writeFileSync(lock, '99999');
    const err = await runAgent('q', {}, { ...deps, lock: { waitMs: 50, staleMs: 10_000 } }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetLedgerError);
    expect(err.message).toMatch(/locked/);
    expect(spawn).not.toHaveBeenCalled();
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old); // the holder died a minute ago
    await runAgent('q', {}, { ...deps, lock: { waitMs: 50, staleMs: 10_000 } });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(existsSync(lock)).toBe(false);
  });
});

describe('runAgent refuses real dependencies under vitest', () => {
  const config = parseConfig({ ONCADE_API_KEY: 'oncade_platform_test_fake', ONCADE_BUSINESS_ID: 'biz', AGENT_SANDBOX: 'off' });
  const fakeSpawn = vi.fn();
  let d = '';
  afterEach(() => {
    rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  it.each([
    ['spawn', { which: () => '/nonexistent/claude-test-fake' }],
    ['which', { spawn: fakeSpawn as any }],
  ])('throws when %s is not injected', async (missing, given) => {
    d = mkdtempSync(join(tmpdir(), 'run-agent-guard-'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = await runAgent('q', {}, { config, runsLog: join(d, 'runs.jsonl'), ...given }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(new RegExp(`real ${missing}.*under vitest`));
    expect(fakeSpawn).not.toHaveBeenCalled();
  });
});

const base: RunRecord = {
  ts: '',
  runId: 'r',
  source: 'test',
  mode: 'read-only',
  promptVersion: 'v1',
  promptSha256: 'x',
  model: 'm',
  toolsCalled: [],
  isError: false,
  timedOut: false,
  sandboxed: false,
};

describe('agentMode', () => {
  it('is read-only unless allowChanges is exactly true', () => {
    expect(agentMode(undefined)).toEqual({ readOnly: true, mode: 'read-only' });
    expect(agentMode(false)).toEqual({ readOnly: true, mode: 'read-only' });
    expect(agentMode(true)).toEqual({ readOnly: false, mode: 'allow-changes' });
  });
});

describe('runs log', () => {
  const rec = (i: number): RunRecord => ({
    ts: `2026-11-18T00:00:0${i}.000Z`,
    runId: `r${i}`,
    source: 'web',
    mode: 'read-only',
    promptVersion: 'v2',
    promptSha256: 'abc',
    model: 'claude-sonnet',
    toolsCalled: ['list_invoices'],
    isError: false,
    timedOut: false,
    durationMs: 100,
    costUsd: 0.01,
    sandboxed: true,
  });

  it('a written record is read back intact, torn lines are skipped, and the reader shows its fields', () => {
    const d = mkdtempSync(join(tmpdir(), 'runs-test-'));
    try {
      const f = join(d, 'runs.jsonl');
      appendRun(f, rec(1));
      appendFileSync(f, '{"torn":\n');
      appendRun(f, rec(2));
      appendRun(f, rec(3));
      const runs = readRuns(f, 2);
      expect(runs).toEqual([rec(2), rec(3)]);
      const text = formatRuns(runs);
      expect(text).toContain('v2');
      expect(text).toContain('$0.0100');
      expect(text).toContain('bwrap');
      expect(text).toContain('list_invoices');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
