/**
 * oneTeam — the service credential, and how it is signed
 * ============================================================================
 *
 * WHAT THIS IS FOR
 * ----------------
 * The service credential names the user a server is acting as, and it can name
 * *any* user. The Telegram bot holds one; the nginx edge injects one for the
 * unconfigured supervisor panel. Because it can impersonate anyone, a leaked one
 * used to be game over: it was an unsigned, never-expiring plaintext string
 * (`oneteam-user:<userId>`) that anybody who saw it could replay forever.
 *
 * THE TWO SHAPES
 * --------------
 * Legacy, unsigned:   `oneteam-user:<userId>`
 * Signed, expiring:   `oneteam-user:s1.<payload>.<sig>`
 *
 * The signed shape carries the user id and an expiry inside `payload`
 * (base64url JSON), authenticated by an HMAC-SHA256 `sig` over `s1.<payload>`
 * keyed by `ONETEAM_SERVICE_SIGNING_SECRET`. A holder of the secret can mint one
 * (see `signServiceCredential`); anyone else can only replay one until it
 * expires, which is minutes rather than forever.
 *
 * MIGRATION, WITHOUT BREAKING A RUNNING DEPLOY
 * --------------------------------------------
 * `verifyServiceCredential` accepts the legacy shape only while `allowLegacy` is
 * true. The API sets `allowLegacy` to true when no signing secret is configured
 * (so an upgrade changes nothing until the operator opts in) and to false the
 * moment a secret is set — unless `ONETEAM_ALLOW_LEGACY_SERVICE_TOKEN=true` is
 * left as an explicit, temporary escape hatch during rollout. Setting the secret
 * is therefore the single switch that closes the unsigned hole.
 *
 * This module is pure and dependency-free (only Node's `crypto`) so both the API
 * guard that verifies and the bot that mints can share exactly one
 * implementation and never drift.
 */

import { createHmac, timingSafeEqual } from 'crypto';

/** Every service credential, legacy or signed, starts with this. */
export const SERVICE_CREDENTIAL_PREFIX = 'oneteam-user:';

/** The signed body's version tag. Bump it if the payload shape ever changes. */
const SIGNED_VERSION = 's1';

/** How long a minted credential is valid by default. Short on purpose. */
export const DEFAULT_SERVICE_TOKEN_TTL_SECONDS = 300;

/** True for anything carrying the service-credential prefix, signed or not. */
export function isServiceCredential(token: string): boolean {
  return typeof token === 'string' && token.startsWith(SERVICE_CREDENTIAL_PREFIX);
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

/**
 * Mints a signed, expiring service credential.
 *
 * `nowMs` is injectable so tests can pin the clock; production leaves it.
 */
export function signServiceCredential(
  userId: string,
  secret: string,
  ttlSeconds: number = DEFAULT_SERVICE_TOKEN_TTL_SECONDS,
  nowMs: number = Date.now(),
): string {
  if (!userId) throw new Error('signServiceCredential: userId is required');
  if (!secret) throw new Error('signServiceCredential: signing secret is required');

  const exp = Math.floor(nowMs / 1000) + Math.max(1, Math.floor(ttlSeconds));
  const payload = base64url(Buffer.from(JSON.stringify({ u: userId, e: exp }), 'utf8'));
  const body = `${SIGNED_VERSION}.${payload}`;
  const sig = base64url(hmac(secret, body));
  return `${SERVICE_CREDENTIAL_PREFIX}${body}.${sig}`;
}

export interface VerifyServiceCredentialOptions {
  /** The HMAC key. When absent, only a legacy token can possibly verify. */
  signingSecret?: string | null;
  /** Whether an unsigned `oneteam-user:<id>` is still honoured. */
  allowLegacy: boolean;
  /** Injectable clock for tests. */
  nowMs?: number;
}

export type ServiceCredentialResult =
  | { userId: string; signed: boolean }
  | null;

/**
 * Verifies a service credential and returns the user it names, or null.
 *
 * Never throws — a malformed token is simply not a credential. The signature
 * check is constant-time, and expiry is enforced before the id is trusted.
 */
export function verifyServiceCredential(
  token: string,
  options: VerifyServiceCredentialOptions,
): ServiceCredentialResult {
  if (!isServiceCredential(token)) return null;
  const rest = token.slice(SERVICE_CREDENTIAL_PREFIX.length);

  // Signed shape: s1.<payload>.<sig>
  if (rest.startsWith(`${SIGNED_VERSION}.`)) {
    const secret = options.signingSecret;
    if (!secret) return null;

    const parts = rest.split('.');
    if (parts.length !== 3) return null;
    const [, payloadB64, sigB64] = parts;
    const body = `${SIGNED_VERSION}.${payloadB64}`;

    const expected = hmac(secret, body);
    let provided: Buffer;
    try {
      provided = fromBase64url(sigB64);
    } catch {
      return null;
    }
    if (provided.length !== expected.length) return null;
    if (!timingSafeEqual(provided, expected)) return null;

    let claims: { u?: unknown; e?: unknown };
    try {
      claims = JSON.parse(fromBase64url(payloadB64).toString('utf8'));
    } catch {
      return null;
    }
    const userId = typeof claims.u === 'string' ? claims.u : null;
    const exp = typeof claims.e === 'number' ? claims.e : null;
    if (!userId || !exp) return null;

    const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
    if (now >= exp) return null;

    return { userId, signed: true };
  }

  // Legacy unsigned shape: oneteam-user:<userId>
  if (!options.allowLegacy) return null;
  const userId = rest.trim();
  return userId ? { userId, signed: false } : null;
}
