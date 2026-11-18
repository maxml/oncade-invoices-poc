import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig, parseOncadeConfig } from './config';

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
    expect(p).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ONCADE_API_KEY: .*TEST platform key/),
        expect.stringMatching(/^ONCADE_BUSINESS_ID: .*required/),
        expect.stringMatching(/^AGENT_SANDBOX: .*auto/),
      ]),
    );
    expect(p.some((x) => x.startsWith('AGENT_MAX_TURNS:'))).toBe(true);
    expect(p.some((x) => x.startsWith('PORT:'))).toBe(true);
    expect(() => parseConfig({})).toThrow(/Invalid configuration[\s\S]*- ONCADE_API_KEY: is required/);
  });

  it('rejects a live key with exactly one problem, naming ONCADE_API_KEY and the test-key rule', () => {
    expect(problems({ ...base, ONCADE_API_KEY: 'oncade_platform_live_x' })).toEqual([
      expect.stringMatching(/^ONCADE_API_KEY: must be an Oncade TEST platform key/),
    ]);
  });

  it('refuses the same port for the UI and the webhook receiver', () => {
    expect(problems({ ...base, PORT: '3001' })).toEqual([expect.stringMatching(/^WEBHOOK_PORT: must differ from PORT/)]);
  });

  it('refuses a negative daily budget but allows 0 (all runs blocked)', () => {
    expect(problems({ ...base, AGENT_DAILY_BUDGET_USD: '-1' })).toHaveLength(1);
    expect(parseConfig({ ...base, AGENT_DAILY_BUDGET_USD: '0' }).AGENT_DAILY_BUDGET_USD).toBe(0);
  });
});

describe('parseOncadeConfig (pnpm demo)', () => {
  it('keeps only the Oncade part and ignores agent, LLM and admin settings, even invalid ones', () => {
    const c = parseOncadeConfig({ ...base, AGENT_SANDBOX: 'maybe', PORT: '3001', ANTHROPIC_API_KEY: 'x' });
    expect(c).toEqual({ ONCADE_API_KEY: base.ONCADE_API_KEY, ONCADE_BUSINESS_ID: 'biz', WEBHOOK_PORT: 3001 });
  });

  it('applies the same Oncade rules: test key only, both variables required', () => {
    expect(() => parseOncadeConfig({ ...base, ONCADE_API_KEY: 'oncade_platform_live_x' })).toThrow(/TEST platform key/);
    try {
      parseOncadeConfig({ ONCADE_API_KEY: '' });
      expect.fail('should throw');
    } catch (e) {
      expect((e as ConfigError).problems).toEqual([
        'ONCADE_API_KEY: is required (an Oncade test platform key, see .env.example)',
        'ONCADE_BUSINESS_ID: is required (shown in the developer portal)',
      ]);
    }
  });
});
