/** Start the CLI, collect its stdout lines and stderr, and kill it at the timeout. */
import type { spawn as nodeSpawn } from 'node:child_process';

export interface CliOutput {
  lines: string[];
  stderr: string;
}

/**
 * Resolves with the non-empty stdout lines once the process closes; rejects on a spawn error or
 * when it closes with no output. `state.timedOut` is set when the timeout kills it, and stays
 * readable by the caller whether this resolves or rejects.
 */
export function runCli(
  spawn: typeof nodeSpawn,
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; cwd: string; timeoutMs: number },
  state: { timedOut: boolean },
): Promise<CliOutput> {
  return new Promise<CliOutput>((ok, fail) => {
    const p = spawn(cmd, args, { env: opts.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      state.timedOut = true;
      p.kill('SIGKILL');
    }, opts.timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(timer);
      const ls = out.split('\n').filter(Boolean);
      if (!ls.length) fail(new Error(`agent exited ${code}${state.timedOut ? ' (timeout)' : ''}: ${err.slice(-2000)}`));
      else ok({ lines: ls, stderr: err });
    });
  });
}
