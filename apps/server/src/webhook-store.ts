/**
 * Verified webhook events, appended to a JSONL file with replay/duplicate protection.
 *
 * - Dedupe key: the event's `id` when it has one, else sha256 of the raw body. Oncade's platform
 *   events carry no id (event, data, timestamp), and a retry re-sends the same signed body, so the
 *   body hash is what identifies a delivery. The key is stored on each line, and the set of seen
 *   keys is rebuilt from the files on start, so a restart does not forget them.
 * - Size cap: when the log would exceed `maxBytes` it is rotated to `<file>.1` (one generation
 *   kept). Keys from both files are remembered, so dedupe survives one rotation.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type IngestResult =
  | { status: 'stored'; key: string; event: string | undefined }
  | { status: 'duplicate'; key: string }
  | { status: 'invalid_json' };

export const DEFAULT_MAX_LOG_BYTES = 1_000_000;

export function dedupeKey(raw: Buffer, event: Record<string, unknown>): string {
  if (typeof event.id === 'string' && event.id) return `id:${event.id}`;
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

export class WebhookStore {
  private seen = new Set<string>();

  constructor(
    readonly file: string,
    private readonly maxBytes = DEFAULT_MAX_LOG_BYTES,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.loadKeys(`${file}.1`);
    this.loadKeys(file);
  }

  /** Call only after the signature was verified. Never throws on bad input. */
  ingest(raw: Buffer): IngestResult {
    let event: unknown;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return { status: 'invalid_json' };
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return { status: 'invalid_json' };
    const ev = event as Record<string, unknown>;
    const key = dedupeKey(raw, ev);
    if (this.seen.has(key)) return { status: 'duplicate', key };
    const line = JSON.stringify({ ...ev, receivedAt: this.now().toISOString(), dedupeKey: key }) + '\n';
    mkdirSync(dirname(this.file), { recursive: true });
    if (existsSync(this.file) && statSync(this.file).size + Buffer.byteLength(line) > this.maxBytes) this.rotate();
    appendFileSync(this.file, line);
    this.seen.add(key);
    return { status: 'stored', key, event: typeof ev.event === 'string' ? ev.event : undefined };
  }

  private rotate() {
    renameSync(this.file, `${this.file}.1`);
    this.seen = new Set();
    this.loadKeys(`${this.file}.1`);
  }

  private loadKeys(path: string) {
    if (!existsSync(path)) return;
    for (const l of readFileSync(path, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try {
        const k = JSON.parse(l).dedupeKey;
        if (typeof k === 'string') this.seen.add(k);
      } catch {
        // a torn line is skipped
      }
    }
  }
}
