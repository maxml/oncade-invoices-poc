import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from './config';

const base = { ONCADE_API_KEY: 'oncade_platform_test_fake', ONCADE_BUSINESS_ID: 'biz' };

const problems = (env: Record<string, string | undefined>) => {
  try {
    parseConfig(env);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).problems;
  }
};

describe('parseConfig', () => {
  it('fills defaults and coerces numbers; empty values count as unset', () => {
    const c = parseConfig({ ...base, AGENT_MAX_TURNS: '7', AGENT_MODEL: '', PORT: '' });
    expect(c).toMatchObject({
      AGENT_MODEL: 'sonnet',
      AGENT_SANDBOX: 'auto',
      AGENT_MAX_TURNS: 7,
      AGENT_TIMEOUT_MS: 180_000,
      AGENT_MAX_BUDGET_USD: 0.5,
      AGENT_DAILY_BUDGET_USD: 2,
      PORT: 3000,
      WEBHOOK_PORT: 3001,
      ADMIN_USER: 'admin',
    });
  });

  it('names every bad variable in one readable error', () => {
    const p = problems({
      ONCADE_API_KEY: 'oncade_platform_live_x',
      AGENT_SANDBOX: 'maybe',
      AGENT_MAX_TURNS: 'many',
      PORT: '70000',
    });
    expect(p.find((x) => x.startsWith('ONCADE_API_KEY:'))).toMatch(/TEST platform key/);
    expect(p.find((x) => x.startsWith('ONCADE_BUSINESS_ID:'))).toMatch(/required/);
    expect(p.find((x) => x.startsWith('AGENT_SANDBOX:'))).toMatch(/auto/);
    expect(p.some((x) => x.startsWith('AGENT_MAX_TURNS:'))).toBe(true);
    expect(p.some((x) => x.startsWith('PORT:'))).toBe(true);
    expect(() => parseConfig({})).toThrow(/Invalid configuration[\s\S]*- ONCADE_API_KEY: is required/);
  });

  it('refuses the same port for the UI and the webhook receiver', () => {
    expect(problems({ ...base, PORT: '3001' })).toEqual([expect.stringMatching(/^WEBHOOK_PORT: must differ from PORT/)]);
  });

  it('refuses a negative daily budget but allows 0 (all runs blocked)', () => {
    expect(problems({ ...base, AGENT_DAILY_BUDGET_USD: '-1' })).toHaveLength(1);
    expect(parseConfig({ ...base, AGENT_DAILY_BUDGET_USD: '0' }).AGENT_DAILY_BUDGET_USD).toBe(0);
  });
});
