/** System prompt identity: version from prompts/CHANGELOG.md, hash of prompts/system.md. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PROMPTS_DIR = resolve(import.meta.dirname, '../prompts');
export const SYSTEM_PROMPT_FILE = join(PROMPTS_DIR, 'system.md');

export interface PromptInfo {
  version: string;
  /** Hash recorded in the changelog for this version (12 hex). */
  changelogHash: string;
  /** Full SHA-256 of the system prompt file as it is now. */
  sha256: string;
}

export function promptInfo(dir = PROMPTS_DIR): PromptInfo {
  const changelog = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  const m = changelog.match(/^## (v\d+) sha256:([0-9a-f]{12}) /m);
  if (!m) throw new Error('prompts/CHANGELOG.md has no "## vN sha256:<12 hex> DATE" entry');
  const sha256 = createHash('sha256').update(readFileSync(join(dir, 'system.md'))).digest('hex');
  return { version: m[1], changelogHash: m[2], sha256 };
}
