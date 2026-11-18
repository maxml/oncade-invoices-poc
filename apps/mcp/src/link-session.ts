/**
 * request_invoice_access used to create a new Oncade link session on every call (every 403).
 * Policy: reuse the last session while it is younger than `maxAgeMs` and Oncade's own
 * `expiresAt` (if any) is still in the future. The cache is one JSON file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CachedLinkSession {
  createdAt: string;
  scopes: string[];
  session: unknown;
}

export const LINK_SESSION_MAX_AGE_MS = 30 * 60_000;

export async function getOrCreateLinkSession(
  file: string,
  scopes: string[],
  create: () => Promise<unknown>,
  opts: { now?: () => number; maxAgeMs?: number } = {},
): Promise<{ reused: boolean; session: unknown }> {
  const now = opts.now ?? Date.now;
  const maxAge = opts.maxAgeMs ?? LINK_SESSION_MAX_AGE_MS;
  const cached = read(file);
  if (cached && isFresh(cached, scopes, now(), maxAge)) return { reused: true, session: cached.session };
  const session = await create();
  const rec: CachedLinkSession = { createdAt: new Date(now()).toISOString(), scopes: [...scopes].sort(), session };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(rec));
    renameSync(`${file}.tmp`, file);
  } catch {
    // Read-only location: still return the session; the next call simply creates another one.
  }
  return { reused: false, session };
}

function isFresh(c: CachedLinkSession, scopes: string[], now: number, maxAge: number): boolean {
  const created = Date.parse(c.createdAt);
  if (!Number.isFinite(created) || now - created >= maxAge || now < created) return false;
  if ([...scopes].sort().join(' ') !== c.scopes.join(' ')) return false;
  const exp = (c.session as { expiresAt?: unknown } | null)?.expiresAt;
  if (typeof exp === 'string' && Number.isFinite(Date.parse(exp)) && Date.parse(exp) <= now) return false;
  return true;
}

function read(file: string): CachedLinkSession | null {
  if (!existsSync(file)) return null;
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v.createdAt === 'string' && Array.isArray(v.scopes) ? v : null;
  } catch {
    return null;
  }
}
