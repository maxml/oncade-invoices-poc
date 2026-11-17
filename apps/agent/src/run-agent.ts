/**
 * Runs one agent turn: Claude Code CLI in headless mode (`claude -p`), with no built-in
 * tools and only the Oncade MCP server, optionally inside a bubblewrap sandbox.
 * Auth comes from the CLI itself: a logged-in Claude Code, or ANTHROPIC_API_KEY.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');

export interface AgentResult {
  answer: string;
  toolCalls: { name: string; input: unknown }[];
  isError: boolean;
  costUsd?: number;
  durationMs?: number;
  sandboxed: boolean;
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

/** Minimal bwrap: read-only system and code, private /tmp, network on, nothing else of $HOME. */
function bwrapArgs(claudeBin: string, workDir: string): string[] {
  const home = homedir();
  const nodeRoot = resolve(dirname(process.execPath), '..');
  const claudeReal = spawnSync('readlink', ['-f', claudeBin], { encoding: 'utf8' }).stdout.trim();
  const args = [
    '--unshare-all', '--share-net', '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--ro-bind', '/etc', '/etc',
    '--tmpfs', home,
    '--ro-bind', nodeRoot, nodeRoot,
    '--ro-bind', claudeReal, claudeReal,
    '--ro-bind', claudeBin, claudeBin,
    '--ro-bind', ROOT, ROOT,
    '--bind', workDir, workDir,
  ];
  // /etc/resolv.conf is often a symlink into /run (systemd-resolved). Without its target,
  // DNS fails inside the sandbox and the CLI retries silently until the timeout.
  const resolv = realpathSync('/etc/resolv.conf');
  if (!resolv.startsWith('/etc/') && !resolv.startsWith('/usr/')) args.push('--ro-bind', resolv, resolv);
  // Subscription login: the CLI needs its credentials file (and refreshes it in place).
  const creds = join(home, '.claude', '.credentials.json');
  if (existsSync(creds)) args.push('--bind', creds, creds);
  const data = join(ROOT, 'data');
  if (existsSync(data)) args.push('--ro-bind', data, data);
  args.push('--chdir', ROOT);
  return args;
}

export async function runAgent(prompt: string): Promise<AgentResult> {
  const claudeBin = which('claude');
  if (!claudeBin) throw new Error('Claude Code CLI not found: install it and log in, or set ANTHROPIC_API_KEY');

  const workDir = mkdtempSync(join(tmpdir(), 'oncade-agent-'));
  const mcpConfig = join(workDir, 'mcp.json');
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        oncade: { command: process.execPath, args: ['--import', 'tsx', join(ROOT, 'apps/mcp/src/server.ts')], cwd: ROOT },
      },
    }),
  );

  const claudeArgs = [
    '-p', prompt,
    '--model', process.env.AGENT_MODEL ?? 'sonnet',
    '--system-prompt-file', join(ROOT, 'apps/agent/prompts/system.md'),
    '--tools', '',
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--allowedTools', 'mcp__oncade',
    '--setting-sources', '',
    '--no-session-persistence',
    '--output-format', 'stream-json', '--verbose',
  ];

  const mode = process.env.AGENT_SANDBOX ?? 'auto';
  const bwrap = which('bwrap');
  const sandboxed = mode !== 'off' && !!bwrap;
  if (mode === 'on' && !bwrap) throw new Error('AGENT_SANDBOX=on but bwrap is not installed');
  if (!sandboxed) console.warn('[agent] running WITHOUT bwrap sandbox');

  const [cmd, args] = sandboxed
    ? [bwrap!, [...bwrapArgs(claudeBin, workDir), '--clearenv', ...Object.entries(agentEnv()).flatMap(([k, v]) => ['--setenv', k, v]), claudeBin, ...claudeArgs]]
    : [claudeBin, claudeArgs];

  try {
    let stderr = '';
    const lines = await new Promise<string[]>((ok, fail) => {
      const p = spawn(cmd, args, { env: sandboxed ? {} : agentEnv(), cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => p.kill('SIGKILL'), Number(process.env.AGENT_TIMEOUT_MS ?? 180_000));
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => {
        clearTimeout(timer);
        stderr = err;
        const ls = out.split('\n').filter(Boolean);
        if (!ls.length) fail(new Error(`agent exited ${code}: ${err.slice(-2000)}`));
        else ok(ls);
      });
    });

    const toolCalls: AgentResult['toolCalls'] = [];
    let final: Record<string, unknown> | undefined;
    for (const l of lines) {
      let ev: Record<string, any>;
      try {
        ev = JSON.parse(l);
      } catch {
        continue;
      }
      if (ev.type === 'assistant') {
        for (const b of ev.message?.content ?? []) if (b.type === 'tool_use') toolCalls.push({ name: b.name, input: b.input });
      }
      if (ev.type === 'result') final = ev;
    }
    return {
      answer: String(final?.result ?? `No answer (agent produced no result event). stderr: ${stderr.slice(-1000) || 'empty'}`),
      toolCalls,
      isError: Boolean(final?.is_error ?? !final),
      costUsd: final?.total_cost_usd as number | undefined,
      durationMs: final?.duration_ms as number | undefined,
      sandboxed,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
