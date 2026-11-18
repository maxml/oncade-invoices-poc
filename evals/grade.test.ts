import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countSentences, fillTemplate, grade, type EvalCase } from './grade';

const base: EvalCase = { id: 'x', description: '', prompt: 'p', mode: 'read-only', assert: {} };
const run = (names: string[], answer = 'ok', mode: EvalCase['mode'] = 'read-only') => ({
  answer,
  toolCalls: names.map((name) => ({ name })),
  isError: false,
  mode,
});

describe('grade', () => {
  it('fails any write tool in read-only mode even if the case does not mention it', () => {
    expect(grade(base, run(['list_invoices', 'cancel_invoice']))).toEqual(['write tool cancel_invoice called in read-only mode']);
  });

  it('checks called / not called / no tools', () => {
    const c = { ...base, mode: 'allow-changes' as const, assert: { toolsCalled: ['get_invoice'], toolsNotCalled: ['cancel_invoice'] } };
    expect(grade(c, run(['get_invoice'], 'ok', 'allow-changes'))).toEqual([]);
    expect(grade(c, run(['cancel_invoice'], 'ok', 'allow-changes'))).toEqual(['expected call to get_invoice', 'unexpected call to cancel_invoice']);
    expect(grade({ ...base, assert: { noTools: true } }, run(['get_platform']))).toHaveLength(1);
  });

  it('lookupBeforeWrite: a write must follow a lookup', () => {
    const c = { ...base, mode: 'allow-changes' as const, assert: { lookupBeforeWrite: true } };
    expect(grade(c, run(['list_invoices', 'send_invoice'], 'ok', 'allow-changes'))).toEqual([]);
    expect(grade(c, run(['send_invoice', 'list_invoices'], 'ok', 'allow-changes'))).toEqual(['send_invoice called before any lookup']);
    expect(grade(c, run([], 'Which invoice?', 'allow-changes'))).toEqual([]);
  });

  it('checks answer regexes, sentence count and real counts', () => {
    const c = { ...base, assert: { answerMatches: ['allow changes'], answerNotMatches: ['paris'], maxSentences: 1, answerContainsCountsFor: ['draft', 'sent'] } };
    expect(grade(c, run([], 'You have 3 drafts and 1 sent; tick Allow changes.'), { counts: { draft: 3, sent: 1 } })).toEqual([]);
    expect(grade(c, run([], 'Paris. Allow changes. 13 drafts.'), { counts: { draft: 3, sent: 1 } })).toEqual([
      'answer matches forbidden /paris/i',
      'answer has 3 sentences, max 1',
      'answer lacks the real draft count (3)',
      'answer lacks the real sent count (1)',
    ]);
  });

  it('fails an errored run and a run in the wrong mode', () => {
    expect(grade(base, { ...run([]), isError: true, mode: 'allow-changes' })).toEqual(['run ended with is_error', 'ran in allow-changes, case wants read-only']);
  });
});

describe('helpers', () => {
  it('countSentences', () => {
    expect(countSentences('I can only help with invoices for this account.')).toBe(1);
    expect(countSentences('Sorry, e.g. weather is out of scope. Ask about invoices!')).toBe(2);
  });
  it('fillTemplate rejects unknown placeholders', () => {
    expect(fillTemplate('cancel {{id}}', { id: 'inv_1' })).toBe('cancel inv_1');
    expect(() => fillTemplate('{{nope}}', {})).toThrow(/nope/);
  });
});

describe('evals/cases.json', () => {
  const cases: EvalCase[] = JSON.parse(readFileSync(join(import.meta.dirname, 'cases.json'), 'utf8')).cases;
  it('has 6-8 well-formed cases with unique ids, covering both modes', () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
    expect(cases.length).toBeLessThanOrEqual(8);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => c.mode))).toEqual(new Set(['read-only', 'allow-changes']));
    for (const c of cases) expect(Object.keys(c.assert).length).toBeGreaterThan(0);
  });
});
