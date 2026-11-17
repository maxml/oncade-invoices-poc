import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyOncadeSignature } from './webhook';

const secret = 'whsec_test';
const body = JSON.stringify({ event: 'Platform.Invoice.Created', data: { invoiceId: 'inv_1' } });
const sign = (b: string, s = secret) => createHmac('sha256', s).update(b).digest('hex');

describe('verifyOncadeSignature', () => {
  it('accepts a valid signature over the raw body', () => {
    expect(verifyOncadeSignature(body, sign(body), secret)).toBe(true);
  });

  it('rejects a signature made with another secret', () => {
    expect(verifyOncadeSignature(body, sign(body, 'other'), secret)).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(verifyOncadeSignature(body + ' ', sign(body), secret)).toBe(false);
  });

  // Regression for the sample in dev.oncade.xyz/docs/guides/webhooks, which throws here.
  it.each([undefined, '', 'abc', 'z'.repeat(64), sign(body).slice(0, 62)])(
    'returns false instead of throwing for malformed signature %s',
    (sig) => {
      expect(() => verifyOncadeSignature(body, sig, secret)).not.toThrow();
      expect(verifyOncadeSignature(body, sig, secret)).toBe(false);
    },
  );
});
