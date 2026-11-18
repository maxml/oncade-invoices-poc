/**
 * The bubblewrap sandbox around the CLI and the env it gets. Do not widen it without a reason
 * written next to the bind that needs it (AGENTS.md).
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config } from '../../../packages/config/src/config';

/** Env the agent (and the MCP server it starts) gets: nothing else from the host leaks in. */
export function agentEnv(c: Config): Record<string, string> {
  const pass = {
    ONCADE_API_KEY: c.ONCADE_API_KEY,
    ONCADE_BUSINESS_ID: c.ONCADE_BUSINESS_ID,
    ANTHROPIC_API_KEY: c.ANTHROPIC_API_KEY,
    WEBHOOK_LOG: c.WEBHOOK_LOG,
  };
  const env: Record<string, string> = {
    HOME: homedir(),
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: 'C.UTF-8',
  };
  for (const [k, v] of Object.entries(pass)) if (v) env[k] = v;
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
  // prettier-ignore
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

/** The full bwrap argv that runs `claudeBin claudeArgs` inside the sandbox with exactly `env`. */
export function sandboxedArgs(s: SandboxInput, env: Record<string, string>, claudeArgs: string[]): string[] {
  return [
    ...bwrapArgs(s),
    '--clearenv',
    ...Object.entries(env).flatMap(([k, v]) => ['--setenv', k, v]),
    s.claudeBin,
    ...claudeArgs,
  ];
}
