/**
 * Service credential for HTTP suites.
 *
 * The API accepts the unsigned `oneteam-user:<id>` shape only while no signing
 * secret is configured. A deployment (or a local .env) that sets
 * ONETEAM_SERVICE_SIGNING_SECRET therefore rejects every hardcoded legacy token
 * these suites used to send. This mints the signed, expiring shape with the same
 * secret the API loads — dotenv included, exactly like apps/api/src/main.ts —
 * and falls back to the legacy shape only when no secret exists.
 */
import 'dotenv/config';
import { signServiceCredential } from '@oneteam/types';

export function serviceToken(userId: string): string {
  const secret = (process.env.ONETEAM_SERVICE_SIGNING_SECRET || '').trim();
  // One hour: a suite must never fail because a token minted at import expired
  // mid-run, and a test credential never leaves the process.
  return secret ? signServiceCredential(userId, secret, 3600) : `oneteam-user:${userId}`;
}
