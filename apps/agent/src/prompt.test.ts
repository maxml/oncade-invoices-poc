import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { promptInfo } from './prompt';

describe('system prompt versioning', () => {
  it('the newest CHANGELOG entry matches the current system.md (bump the version when you edit the prompt)', () => {
    const p = promptInfo();
    expect(p.version).toMatch(/^v\d+$/);
    expect(p.sha256.slice(0, 12)).toBe(p.changelogHash);
  });

  it('reads the newest (first) entry', () => {
    const d = mkdtempSync(join(tmpdir(), 'prompt-test-'));
    try {
      writeFileSync(join(d, 'system.md'), 'x');
      writeFileSync(join(d, 'CHANGELOG.md'), '# c\n\n## v3 sha256:aaaaaaaaaaaa 2026-01-02\n\n## v2 sha256:bbbbbbbbbbbb 2026-01-01\n');
      expect(promptInfo(d)).toMatchObject({ version: 'v3', changelogHash: 'aaaaaaaaaaaa' });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
