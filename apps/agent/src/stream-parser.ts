/** Reading the CLI's `--output-format stream-json` output: tool calls, the result event, the answer. */

export interface ToolCall {
  name: string;
  input: unknown;
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

/** The answer text: the result event's, else why there is none (timeout, or the CLI's stderr tail). */
export function answerOf(final: ParsedStream['final'], timedOut: boolean, stderr: string): string {
  return String(
    final?.result ??
      (timedOut
        ? 'The agent run timed out.'
        : `No answer (agent produced no result event: ${final?.subtype ?? 'none'}). stderr: ${stderr.slice(-1000) || 'empty'}`),
  );
}

/** A run is an error when the result event says so, when there is none, or when it timed out. */
export function isErrorRun(final: ParsedStream['final'], timedOut: boolean): boolean {
  return Boolean(final?.is_error ?? !final) || timedOut;
}
