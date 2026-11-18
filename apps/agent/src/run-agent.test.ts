import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bwrapArgs, ETC_FILES, mcpConfig, parseAgentStream, type SandboxInput } from './run-agent';
import { appendRun, formatRuns, readRuns, type RunRecord } from './runs';

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
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__oncade__get_invoice', input: { invoiceId: 'a' } }] } }),
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
    for (let i = 0; i < a.length; i++) if (a[i] === '--bind' || a[i] === '--ro-bind') out.push({ kind: a[i], src: a[i + 1], dst: a[i + 2] });
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
    expect(b.filter((x) => x.src.startsWith('/home/u/') && !x.src.startsWith('/home/u/.nvm') && !x.src.startsWith('/home/u/.local'))).toEqual([]);
    expect(b.some((x) => x.src.includes('.credentials.json'))).toBe(false);
  });

  it('without an API key binds only the credentials file from ~/.claude (read-write, for token refresh)', () => {
    const b = binds(bwrapArgs(base)).filter((x) => x.src.includes('/.claude/'));
    expect(b).toEqual([{ kind: '--bind', src: '/home/u/.claude/.credentials.json', dst: '/home/u/.claude/.credentials.json' }]);
  });

  it('code and data are read-only; only the work dir and data/state are writable', () => {
    const rw = binds(bwrapArgs(base)).filter((x) => x.kind === '--bind').map((x) => x.dst);
    expect(rw.sort()).toEqual(['/home/u/.claude/.credentials.json', '/repo/data/state', '/tmp/oncade-agent-x'].sort());
  });
});

describe('mcpConfig', () => {
  it('passes the mode and run id to the MCP server through its env', () => {
    expect(mcpConfig({ readOnly: true, runId: 'r1' }).mcpServers.oncade.env).toEqual({ ONCADE_READ_ONLY: '1', ONCADE_RUN_ID: 'r1' });
    expect(mcpConfig({ readOnly: false, runId: 'r2' }).mcpServers.oncade.env.ONCADE_READ_ONLY).toBe('0');
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
