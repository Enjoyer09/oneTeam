import { describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';
import { mintDevServiceCredential } from '../../scripts/dev-service-credential';

// Pins the wire format the canonical verifier (packages/types, test:signing)
// expects: oneteam-user:s1.<base64url JSON {u,e}>.<HMAC-SHA256 base64url>.
describe('dev proxy service credential', () => {
  it('mints the s1 shape the API verifies', () => {
    const now = 1_800_000_000_000;
    const token = mintDevServiceCredential('usr-admin-001', 'test-secret', 300, now);
    expect(token.startsWith('oneteam-user:s1.')).toBe(true);
    const [payload, sig] = token.slice('oneteam-user:s1.'.length).split('.');
    const expected = createHmac('sha256', 'test-secret')
      .update(`s1.${payload}`)
      .digest('base64url');
    expect(sig).toBe(expected);
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).toEqual({
      u: 'usr-admin-001',
      e: Math.floor(now / 1000) + 300,
    });
  });

  it('refuses empty identities and secrets', () => {
    expect(() => mintDevServiceCredential('', 'secret')).toThrow();
    expect(() => mintDevServiceCredential('usr-1', '')).toThrow();
  });
});
