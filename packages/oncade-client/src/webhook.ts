import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify `x-oncade-signature`: hex HMAC-SHA256 of the raw body with the platform webhook secret.
 * Never throws: a missing, malformed or wrong-length signature returns false (-> 401),
 * unlike the sample in Oncade's game webhooks guide, which throws on a length mismatch (-> 500).
 */
export function verifyOncadeSignature(rawBody: Buffer | string, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
