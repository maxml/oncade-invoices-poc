/**
 * Runs one agent turn: Claude Code CLI in headless mode (`claude -p`), with no built-in
 * tools and only the Oncade MCP server, optionally inside a bubblewrap sandbox.
 * Auth comes from the CLI itself: ANTHROPIC_API_KEY when set, else a logged-in Claude Code.
 *
 * The caller decides the mode before the agent starts: read-only (default) or allow-changes.
 * In read-only mode the MCP server is started with ONCADE_READ_ONLY=1 and has no write tools.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, rmSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promptInfo, SYSTEM_PROMPT_FILE } from './prompt';
import { appendRun, DEFAULT_RUNS_LOG, type RunRecord } from './runs';

const ROOT = resolve(import.meta.dirname, '../../..');
const WRITE_TOOLS = ['create_draft_invoice', 'send_invoice', 'cancel_invoice'];

export interface AgentOptions {
  /** Register the write tools (create / send / cancel). Default false. */
  allowChanges?: boolean;
  /** Scopes the deterministic Idempotency-Key of writes. Default: a new id per run. */
  runId?: string;
  /** Where the run came from, recorded in data/runs.jsonl ("web", "cli", "eval"). */
  source?: string;
}

export interface ToolCall {
  name: string;
  input: unknown;
}

export interface AgentResult {
  answer: string;
  toolCalls: ToolCall[];
  isError: boolean;
  timedOut: boolean;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  sandboxed: boolean;
  runId: string;
  mode: 'read-only' | 'allow-changes';
  model: string;
  promptVersion: string;
}

export interface ParsedStream {
  toolCalls: ToolCall[];
  final?: Record<string, any>;
  model?: string;
}

/**
 * Parse `--output-format stream-json` lines: tool calls in order (MCP prefix stripped),
 * the final `result` event and the model from the `system/init` event. Never throws.
 */
export function parseAgentStream(lines: string[]): ParsedStream {
  const out: ParsedStream = { toolCalls: [] };
  for (const l of lines) {
    let ev: any;
    try {
      ev = JSON.parse(l);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string') out.model = ev.model;
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b?.type === 'tool_use' && typeof b.name === 'string') {
          out.toolCalls.push({ name: b.name.replace(/^mcp__oncade__/, ''), input: b.input });
        }
      }
    }
    if (ev.type === 'result') out.final = ev;
  }
  return out;
}

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Env the agent (and the MCP server it starts) gets: nothing else from the host leaks in. */
function agentEnv(): Record<string, string> {
  const pass = ['ONCADE_API_KEY', 'ONCADE_BUSINESS_ID', 'ANTHROPIC_API_KEY', 'WEBHOOK_LOG'];
  const env: Record<string, string> = {
    HOME: homedir(),
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: 'C.UTF-8',
  };
  for (const k of pass) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

/**
 * Files from /etc the run needs; everything else of /etc stays out of the sandbox.
 * Found by running the agent with only these bound (see README, Sandbox).
 */
export const ETC_FILES = [
  '/etc/hosts', // localhost and static names
  '/etc/nsswitch.conf', // how glibc resolves names
  '/etc/host.conf',
  '/etc/gai.conf', // getaddrinfo address ordering
  '/etc/ssl/certs', // CA bundle (entries are symlinks into /usr/share/ca-certificates)
  '/etc/ssl/openssl.cnf',
  '/etc/passwd', // Node's os.userInfo() throws ERR_SYSTEM_ERROR inside bwrap without it (checked)
  '/etc/group', // same, for group lookups; neither file holds password hashes
];

export interface SandboxInput {
  claudeBin: string;
  claudeReal: string;
  nodeRoot: string;
  workDir: string;
  home: string;
  root: string;
  /** Real path of /etc/resolv.conf (often a symlink into /run). */
  resolvConf: string;
  env: { ANTHROPIC_API_KEY?: string };
  exists: (p: string) => boolean;
}

/** Minimal bwrap: read-only system and code, private /tmp, network on, nothing else of $HOME. */
export function bwrapArgs(s: SandboxInput): string[] {
  const args = [
    '--unshare-all', '--share-net', '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--tmpfs', s.home,
    '--ro-bind', s.nodeRoot, s.nodeRoot,
    '--ro-bind', s.claudeReal, s.claudeReal,
    '--ro-bind', s.claudeBin, s.claudeBin,
    '--ro-bind', s.root, s.root,
    '--bind', s.workDir, s.workDir,
  ];
  for (const f of ETC_FILES) if (s.exists(f)) args.push('--ro-bind', f, f);
  // /etc/resolv.conf is often a symlink into /run (systemd-resolved). Bind its target's content
  // at /etc/resolv.conf, or DNS fails and the CLI retries silently until the timeout.
  args.push('--ro-bind', s.resolvConf, '/etc/resolv.conf');
  // Credentials: with ANTHROPIC_API_KEY the CLI needs nothing from $HOME, so nothing is bound.
  // Without it (subscription login) the CLI needs its credentials file, read-WRITE, because it
  // refreshes the OAuth token in place. Trade-off: code in the sandbox can read that token.
  if (!s.env.ANTHROPIC_API_KEY) {
    const creds = join(s.home, '.claude', '.credentials.json');
    if (s.exists(creds)) args.push('--bind', creds, creds);
  }
  const data = join(s.root, 'data');
  if (s.exists(data)) args.push('--ro-bind', data, data);
  // data/state is writable: the MCP server caches the Oncade link session there
  // (request_invoice_access reuses it instead of creating a new one per call).
  const state = join(data, 'state');
  if (s.exists(state)) args.push('--bind', state, state);
  args.push('--chdir', s.root);
  return args;
}

/** The MCP config for one run; the mode lives here, outside anything the model controls. */
export function mcpConfig(opts: { readOnly: boolean; runId: string }) {
  return {
    mcpServers: {
      oncade: {
        command: process.execPath,
        args: ['--import', 'tsx', join(ROOT, 'apps/mcp/src/server.ts')],
        cwd: ROOT,
        env: { ONCADE_READ_ONLY: opts.readOnly ? '1' : '0', ONCADE_RUN_ID: opts.runId },
      },
    },
  };
}

export async function runAgent(prompt: string, opts: AgentOptions = {}): Promise<AgentResult> {
  const claudeBin = which('claude');
  if (!claudeBin) throw new Error('Claude Code CLI not found: install it and log in, or set ANTHROPIC_API_KEY');
  const readOnly = !opts.allowChanges;
  const runId = opts.runId ?? randomUUID();
  const prompt_ = promptInfo();
  const requestedModel = process.env.AGENT_MODEL ?? 'sonnet';

  mkdirSync(join(ROOT, 'data', 'state'), { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), 'oncade-agent-'));
  const mcpConfigFile = join(workDir, 'mcp.json');
  writeFileSync(mcpConfigFile, JSON.stringify(mcpConfig({ readOnly, runId })));

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
    '--max-turns', String(Number(process.env.AGENT_MAX_TURNS ?? 12)),
    '--max-budget-usd', String(Number(process.env.AGENT_MAX_BUDGET_USD ?? 0.5)),
    '--output-format', 'stream-json', '--verbose',
  ];

  const mode = process.env.AGENT_SANDBOX ?? 'auto';
  const bwrap = which('bwrap');
  const sandboxed = mode !== 'off' && !!bwrap;
  if (mode === 'on' && !bwrap) throw new Error('AGENT_SANDBOX=on but bwrap is not installed');
  if (!sandboxed) console.warn('[agent] running WITHOUT bwrap sandbox');

  const env = agentEnv();
  const [cmd, args] = sandboxed
    ? [
        bwrap!,
        [
          ...bwrapArgs({
            claudeBin,
            claudeReal: realpathSync(claudeBin),
            nodeRoot: resolve(dirname(process.execPath), '..'),
            workDir,
            home: homedir(),
            root: ROOT,
            resolvConf: realpathSync('/etc/resolv.conf'),
            env,
            exists: existsSync,
          }),
          '--clearenv',
          ...Object.entries(env).flatMap(([k, v]) => ['--setenv', k, v]),
          claudeBin,
          ...claudeArgs,
        ],
      ]
    : [claudeBin, claudeArgs];

  const started = Date.now();
  let timedOut = false;
  try {
    let stderr = '';
    const lines = await new Promise<string[]>((ok, fail) => {
      const p = spawn(cmd, args, { env: sandboxed ? {} : env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        timedOut = true;
        p.kill('SIGKILL');
      }, Number(process.env.AGENT_TIMEOUT_MS ?? 180_000));
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => {
        clearTimeout(timer);
        stderr = err;
        const ls = out.split('\n').filter(Boolean);
        if (!ls.length) fail(new Error(`agent exited ${code}${timedOut ? ' (timeout)' : ''}: ${err.slice(-2000)}`));
        else ok(ls);
      });
    });

    const parsed = parseAgentStream(lines);
    const final = parsed.final;
    const result: AgentResult = {
      answer: String(
        final?.result ??
          (timedOut
            ? 'The agent run timed out.'
            : `No answer (agent produced no result event: ${final?.subtype ?? 'none'}). stderr: ${stderr.slice(-1000) || 'empty'}`),
      ),
      toolCalls: parsed.toolCalls,
      isError: Boolean(final?.is_error ?? !final) || timedOut,
      timedOut,
      costUsd: final?.total_cost_usd as number | undefined,
      durationMs: (final?.duration_ms as number | undefined) ?? Date.now() - started,
      numTurns: final?.num_turns as number | undefined,
      sandboxed,
      runId,
      mode: readOnly ? 'read-only' : 'allow-changes',
      model: parsed.model ?? requestedModel,
      promptVersion: prompt_.version,
    };
    record(result, prompt_.sha256, opts.source ?? 'cli');
    return result;
  } catch (e) {
    record(
      {
        answer: '', toolCalls: [], isError: true, timedOut, sandboxed, runId,
        mode: readOnly ? 'read-only' : 'allow-changes', model: requestedModel, promptVersion: prompt_.version,
        durationMs: Date.now() - started,
      },
      prompt_.sha256,
      opts.source ?? 'cli',
    );
    throw e;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function record(r: AgentResult, promptSha256: string, source: string) {
  const rec: RunRecord = {
    ts: new Date().toISOString(),
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
    sandboxed: r.sandboxed,
  };
  try {
    appendRun(process.env.RUNS_LOG ?? DEFAULT_RUNS_LOG, rec);
  } catch (e) {
    console.warn(`[agent] could not write the run log: ${String(e)}`);
  }
}
