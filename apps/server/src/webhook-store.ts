/**
 * Verified webhook events, appended to a JSONL file with replay/duplicate protection.
 *
 * - Dedupe key (`dedupeKey`): the event's `id` when it has one, else a hash of the canonical JSON
 *   of event name + timestamp + data. Oncade's platform events carry no id, and a "Resend"
 *   re-delivers the same event, timestamp and data. The key is stored on each line, and on start
 *   the seen set is rebuilt from the files, recomputing the key from each line's content as well,
 *   so a restart does not forget them and lines written by older code still count.
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

/** JSON with object keys sorted at every level: the same value always gives the same text. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** Fields the store adds to a stored line; never part of the event's identity. */
const STORE_FIELDS = ['receivedAt', 'dedupeKey'];

/**
 * The event's identity, from its content, never from the raw bytes: `id` when it has one; else
 * event name + timestamp + data (what an Oncade "Resend" repeats); else the whole event without
 * the store's own fields. Canonical JSON, so whitespace and key order do not matter, and the same
 * function reads a stored line back (`loadKeys`), so lines from older code get the same key.
 */
export function dedupeKey(event: Record<string, unknown>): string {
  if (typeof event.id === 'string' && event.id) return `id:${event.id}`;
  const identity =
    typeof event.event === 'string' && typeof event.timestamp === 'string'
      ? { event: event.event, timestamp: event.timestamp, data: event.data }
      : Object.fromEntries(Object.entries(event).filter(([k]) => !STORE_FIELDS.includes(k)));
  return `sha256:${createHash('sha256').update(canonicalJson(identity)).digest('hex')}`;
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
    const key = dedupeKey(ev);
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
        const stored = JSON.parse(l);
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) continue;
        // The key stored on the line (any scheme), and the key computed now from its content: a
        // line written by older code (no dedupeKey, or a raw-body hash) still dedupes.
        if (typeof stored.dedupeKey === 'string') this.seen.add(stored.dedupeKey);
        this.seen.add(dedupeKey(stored));
      } catch {
        // a torn line is skipped
      }
    }
  }
}
