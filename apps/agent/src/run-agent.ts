/**
 * Runs one agent turn: Claude Code CLI in headless mode (`claude -p`), with no built-in
 * tools and only the Oncade MCP server, optionally inside a bubblewrap sandbox.
 * Auth comes from the CLI itself: ANTHROPIC_API_KEY when set, else a logged-in Claude Code.
 *
 * The caller decides the mode before the agent starts: read-only (default) or allow-changes.
 * In read-only mode the MCP server is started with ONCADE_READ_ONLY=1 and has no write tools.
 *
 * The pieces: request-scope.ts (mode, what the request allows), mcp-config.ts, sandbox.ts,
 * cli-process.ts, stream-parser.ts, budget.ts (daily cap) and runs-log.ts (one line per run).
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, rmSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseConfig, type Config } from '../../../packages/config/src/config';
import { refuseRealInTests } from '../../../packages/config/src/test-guard';
import { defaultLedger, reserveBudget, settleBudget, type BudgetFiles, type LockOptions } from './budget';
import { runCli } from './cli-process';
import { mcpConfig, WRITE_TOOLS } from './mcp-config';
import { promptInfo, SYSTEM_PROMPT_FILE, type PromptInfo } from './prompt';
import { agentMode, requestScope, type AgentMode } from './request-scope';
import { DEFAULT_RUNS_LOG, type RunRecord } from './runs-log';
import { agentEnv, sandboxedArgs } from './sandbox';
import { answerOf, isErrorRun, parseAgentStream, type ToolCall } from './stream-parser';

export type { ToolCall } from './stream-parser';

const ROOT = resolve(import.meta.dirname, '../../..');

export interface AgentOptions {
  /** Register the write tools (create / send / cancel). Default false. */
  allowChanges?: boolean;
  /** Scopes the deterministic Idempotency-Key of writes. Default: a new id per run. */
  runId?: string;
  /** Where the run came from, recorded in data/runs.jsonl ("web", "cli", "eval"). */
  source?: string;
}

export interface AgentResult {
  answer: string;
  toolCalls: ToolCall[];
  isError: boolean;
  timedOut: boolean;
  costUsd?: number;
  /** The CLI reported no cost (crash, timeout): costUsd is the full reservation, AGENT_MAX_BUDGET_USD. */
  costEstimated?: boolean;
  durationMs?: number;
  numTurns?: number;
  sandboxed: boolean;
  runId: string;
  mode: AgentMode;
  model: string;
  promptVersion: string;
}

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** What runAgent touches outside itself; injected in tests. */
export interface AgentDeps {
  config: Config;
  spawn: typeof spawn;
  which: (bin: string) => string | null;
  runsLog: string;
  /** The budget reservation ledger. Default: next to the runs log. */
  ledger: string;
  lock?: LockOptions;
  now: () => Date;
  /** The system prompt's version and hash. Default: read from apps/agent/prompts. */
  promptInfo: () => PromptInfo;
}

function resolveDeps(d: Partial<AgentDeps>): AgentDeps {
  // A test that forgot to inject these would launch the real `claude`: refuse under vitest.
  if (!d.spawn) refuseRealInTests('spawn');
  if (!d.which) refuseRealInTests('which');
  const config = d.config ?? parseConfig(process.env);
  const runsLog = d.runsLog ?? config.RUNS_LOG ?? DEFAULT_RUNS_LOG;
  return {
    config,
    spawn: d.spawn ?? spawn,
    which: d.which ?? which,
    runsLog,
    ledger: d.ledger ?? defaultLedger(runsLog),
    lock: d.lock,
    now: d.now ?? (() => new Date()),
    promptInfo: d.promptInfo ?? (() => promptInfo()),
  };
}

export async function runAgent(
  prompt: string,
  opts: AgentOptions = {},
  overrides: Partial<AgentDeps> = {},
): Promise<AgentResult> {
  const deps = resolveDeps(overrides);
  const cfg = deps.config;
  const claudeBin = deps.which('claude');
  if (!claudeBin) throw new Error('Claude Code CLI not found: install it and log in, or set ANTHROPIC_API_KEY');
  const sandboxMode = cfg.AGENT_SANDBOX;
  const bwrap = deps.which('bwrap');
  const sandboxed = sandboxMode !== 'off' && !!bwrap;
  if (sandboxMode === 'on' && !bwrap) throw new Error('AGENT_SANDBOX=on but bwrap is not installed');

  // Everything that can throw while preparing the run happens before the reservation below: once it
  // is made, the only way out is through settle() (try / catch), or it would be held all day.
  const { readOnly, mode: runMode } = agentMode(opts.allowChanges);
  const runId = opts.runId ?? randomUUID();
  const prompt_ = deps.promptInfo();
  const requestedModel = cfg.AGENT_MODEL;
  const { allowedInvoices, allowedEmails, emailAllowed } = requestScope(prompt, readOnly);

  // Daily spend cap, before anything starts: every entry point (web, CLI, eval) runs here. The run
  // reserves its maximum cost in the shared ledger; settle() below replaces it with the real cost.
  const budget: BudgetFiles = { runsLog: deps.runsLog, ledger: deps.ledger, lock: deps.lock };
  const reservationId = randomUUID();
  const reservationUsd = cfg.AGENT_MAX_BUDGET_USD;
  reserveBudget(budget, { id: reservationId, amountUsd: reservationUsd, capUsd: cfg.AGENT_DAILY_BUDGET_USD, now: deps.now() });
  let spawned = false;
  /** The real cost when the CLI reported one; otherwise, once the CLI ran, the full reservation. */
  const costOf = (reported: unknown): Pick<AgentResult, 'costUsd' | 'costEstimated'> =>
    typeof reported === 'number' && Number.isFinite(reported)
      ? { costUsd: reported }
      : spawned
        ? { costUsd: reservationUsd, costEstimated: true }
        : {};

  let workDir: string | undefined;
  const started = Date.now();
  const run = { timedOut: false };
  try {
    mkdirSync(join(ROOT, 'data', 'state'), { recursive: true });
    workDir = mkdtempSync(join(tmpdir(), 'oncade-agent-'));
    const mcpConfigFile = join(workDir, 'mcp.json');
    writeFileSync(mcpConfigFile, JSON.stringify(mcpConfig({ readOnly, runId, allowedInvoices, allowedEmails, emailAllowed })));

    // prettier-ignore
    const claudeArgs = [
      '-p', prompt,
      '--model', requestedModel,
      '--system-prompt-file', SYSTEM_PROMPT_FILE,
      '--tools', '',
      '--mcp-config', mcpConfigFile, '--strict-mcp-config',
      '--allowedTools', 'mcp__oncade',
      // Defense in depth: in read-only mode the server does not register these anyway.
      ...(readOnly ? ['--disallowedTools', ...WRITE_TOOLS.map((t) => `mcp__oncade__${t}`)] : []),
      '--setting-sources', '',
      '--no-session-persistence',
      '--max-turns', String(cfg.AGENT_MAX_TURNS),
      '--max-budget-usd', String(cfg.AGENT_MAX_BUDGET_USD),
      '--output-format', 'stream-json', '--verbose',
    ];

    if (!sandboxed) console.warn('[agent] running WITHOUT bwrap sandbox');

    const env = agentEnv(cfg);
    const [cmd, args] = sandboxed
      ? [
          bwrap!,
          sandboxedArgs(
            {
              claudeBin,
              claudeReal: realpathSync(claudeBin),
              nodeRoot: resolve(dirname(process.execPath), '..'),
              workDir,
              home: homedir(),
              root: ROOT,
              resolvConf: realpathSync('/etc/resolv.conf'),
              env,
              exists: existsSync,
            },
            env,
            claudeArgs,
          ),
        ]
      : [claudeBin, claudeArgs];

    spawned = true;
    // Sandboxed, bwrap starts with an empty env and sets the agent's own with --setenv.
    const cliOpts = { env: sandboxed ? {} : env, cwd: ROOT, timeoutMs: cfg.AGENT_TIMEOUT_MS };
    const { lines, stderr } = await runCli(deps.spawn, cmd, args, cliOpts, run);

    const parsed = parseAgentStream(lines);
    const final = parsed.final;
    const result: AgentResult = {
      answer: answerOf(final, run.timedOut, stderr),
      toolCalls: parsed.toolCalls,
      isError: isErrorRun(final, run.timedOut),
      timedOut: run.timedOut,
      ...costOf(final?.total_cost_usd),
      durationMs: (final?.duration_ms as number | undefined) ?? Date.now() - started,
      numTurns: final?.num_turns as number | undefined,
      sandboxed,
      runId,
      mode: runMode,
      model: parsed.model ?? requestedModel,
      promptVersion: prompt_.version,
    };
    settle(budget, reservationId, deps, result, prompt_.sha256, opts.source ?? 'cli');
    return result;
  } catch (e) {
    settle(
      budget,
      reservationId,
      deps,
      {
        answer: '',
        toolCalls: [],
        isError: true,
        timedOut: run.timedOut,
        ...costOf(undefined),
        sandboxed,
        runId,
        mode: runMode,
        model: requestedModel,
        promptVersion: prompt_.version,
        durationMs: Date.now() - started,
      },
      prompt_.sha256,
      opts.source ?? 'cli',
    );
    throw e;
  } finally {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  }
}

/** Log the run and release its reservation. On failure the reservation stays, so the cost still counts. */
function settle(
  budget: BudgetFiles,
  reservationId: string,
  deps: AgentDeps,
  r: AgentResult,
  promptSha256: string,
  source: string,
) {
  const rec: RunRecord = {
    ts: deps.now().toISOString(),
    runId: r.runId,
    source,
    mode: r.mode,
    promptVersion: r.promptVersion,
    promptSha256,
    model: r.model,
    toolsCalled: r.toolCalls.map((t) => t.name),
    isError: r.isError,
    timedOut: r.timedOut,
    numTurns: r.numTurns,
    durationMs: r.durationMs,
    costUsd: r.costUsd,
    ...(r.costEstimated ? { costEstimated: true } : {}),
    sandboxed: r.sandboxed,
  };
  try {
    settleBudget(budget, reservationId, rec);
  } catch (e) {
    console.warn(`[agent] could not log the run; its budget reservation stays counted: ${String(e)}`);
  }
}
