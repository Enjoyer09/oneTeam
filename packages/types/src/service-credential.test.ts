/**
 * oneTeam — service credential signing suite
 * ============================================================================
 *
 * WHY THIS EXISTS AS A PERMANENT TEST
 * -----------------------------------
 * The service credential can name ANY user — the bot acts for whichever chat an
 * update came from, and the nginx edge injects one for the unconfigured panel.
 * It used to be an unsigned, never-expiring plaintext string that anybody who
 * saw it could replay forever. `service-credential.ts` replaced that with an
 * HMAC-signed, short-lived token while still accepting the legacy shape during
 * rollout.
 *
 * The load-bearing behaviour is the REFUSALS: a tampered payload, a swapped
 * signature, a wrong key, an expired token, and — the whole point of the
 * migration — a legacy token once a secret is configured, must every one return
 * null. A suite that only checked the happy roundtrip would pass against a
 * verifier that trusted anything. So the refusals are asserted directly, and the
 * asymmetry (legacy honoured only while `allowLegacy` is true) with it.
 *
 * Pure module, pure test: no I/O, no running API. The clock is injected so
 * expiry is exercised deterministically rather than with a sleep.
 */

import {
  isServiceCredential,
  signServiceCredential,
  verifyServiceCredential,
  SERVICE_CREDENTIAL_PREFIX,
  DEFAULT_SERVICE_TOKEN_TTL_SECONDS,
} from './service-credential';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  bright: '\x1b[1m',
};

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  ${colors.green}✅ [PASS]${colors.reset} ${label}`);
  } else {
    failed++;
    console.log(`  ${colors.red}❌ [FAIL]${colors.reset} ${label}`);
    if (detail !== undefined) {
      console.log(`         got: ${JSON.stringify(detail)?.slice(0, 400)}`);
    }
  }
}

console.log(`${colors.bright}oneTeam — service credential signing${colors.reset}`);

const SECRET = 'test-signing-secret-do-not-use-in-prod';
const OTHER_SECRET = 'a-different-secret';
const NOW = 1_700_000_000_000; // fixed clock (ms)

// PLACEHOLDER_SIGNING_TESTS

// ---------------------------------------------------------------------------
// isServiceCredential — the cheap prefix gate.
// ---------------------------------------------------------------------------
{
  check('a legacy token is recognised', isServiceCredential('oneteam-user:usr-1') === true);
  check(
    'a signed token is recognised',
    isServiceCredential(signServiceCredential('usr-1', SECRET, 300, NOW)) === true,
  );
  check('a device token is not', isServiceCredential('otd_abc') === false);
  check('a panel token is not', isServiceCredential('otp_abc') === false);
  check('an empty string is not', isServiceCredential('') === false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  check('a non-string never throws', isServiceCredential(undefined as any) === false);
}

// ---------------------------------------------------------------------------
// Happy roundtrip — a freshly signed token verifies to the same user.
// ---------------------------------------------------------------------------
{
  const token = signServiceCredential('usr-merch-003', SECRET, 300, NOW);
  check('a signed token carries the prefix', token.startsWith(SERVICE_CREDENTIAL_PREFIX));
  check('and the s1 version tag', token.slice(SERVICE_CREDENTIAL_PREFIX.length).startsWith('s1.'));

  const result = verifyServiceCredential(token, {
    signingSecret: SECRET,
    allowLegacy: false,
    nowMs: NOW + 1000,
  });
  check('it verifies to the user it named', result?.userId === 'usr-merch-003', result);
  check('and is reported as signed', result?.signed === true, result);
}

// ---------------------------------------------------------------------------
// Signing preconditions.
// ---------------------------------------------------------------------------
{
  let threwOnUser = false;
  try {
    signServiceCredential('', SECRET, 300, NOW);
  } catch {
    threwOnUser = true;
  }
  check('signing without a userId throws', threwOnUser);

  let threwOnSecret = false;
  try {
    signServiceCredential('usr-1', '', 300, NOW);
  } catch {
    threwOnSecret = true;
  }
  check('signing without a secret throws', threwOnSecret);

  check('the default TTL is 300s (short on purpose)', DEFAULT_SERVICE_TOKEN_TTL_SECONDS === 300);
}

// ---------------------------------------------------------------------------
// Expiry — enforced before the id is trusted.
// ---------------------------------------------------------------------------
{
  const token = signServiceCredential('usr-1', SECRET, 300, NOW);

  const live = verifyServiceCredential(token, {
    signingSecret: SECRET,
    allowLegacy: false,
    nowMs: NOW + 299_000,
  });
  check('a token one second before expiry still verifies', live?.userId === 'usr-1', live);

  const expired = verifyServiceCredential(token, {
    signingSecret: SECRET,
    allowLegacy: false,
    nowMs: NOW + 301_000,
  });
  check('a token past its expiry is refused', expired === null, expired);

  const atBoundary = verifyServiceCredential(token, {
    signingSecret: SECRET,
    allowLegacy: false,
    nowMs: NOW + 300_000,
  });
  check('expiry is inclusive — at exp exactly, refused', atBoundary === null, atBoundary);
}

// ---------------------------------------------------------------------------
// Refusals — the load-bearing half.
// ---------------------------------------------------------------------------
{
  const token = signServiceCredential('usr-1', SECRET, 300, NOW);
  const opts = { signingSecret: SECRET, allowLegacy: false, nowMs: NOW + 1000 };

  // Wrong key.
  check(
    'a token signed with another key is refused',
    verifyServiceCredential(token, { ...opts, signingSecret: OTHER_SECRET }) === null,
  );

  // No key at all — a signed token cannot be honoured without the secret.
  check(
    'a signed token with no configured secret is refused',
    verifyServiceCredential(token, { signingSecret: null, allowLegacy: true, nowMs: NOW + 1000 }) ===
      null,
  );

  // Tampered signature.
  const parts = token.split('.');
  const badSig = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}XX`;
  check('a token with a swapped signature is refused', verifyServiceCredential(badSig, opts) === null);

  // Tampered payload (re-point at admin) without re-signing.
  const forgedPayload = Buffer.from(JSON.stringify({ u: 'usr-admin-001', e: NOW / 1000 + 300 }))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const forged = `${SERVICE_CREDENTIAL_PREFIX}s1.${forgedPayload}.${parts[2]}`;
  check(
    'a token whose payload was edited to name another user is refused',
    verifyServiceCredential(forged, opts) === null,
  );

  // Structurally malformed signed tokens — must return null, never throw.
  const malformed = [
    'oneteam-user:s1.', // no payload/sig
    'oneteam-user:s1.only-two.', // empty sig
    'oneteam-user:s1.a.b.c.d', // too many segments
    'oneteam-user:s1.!!!not-base64!!!.@@@', // undecodable
  ];
  for (const m of malformed) {
    check(`malformed token is refused, not thrown: ${m}`, verifyServiceCredential(m, opts) === null);
  }
}

// ---------------------------------------------------------------------------
// Legacy migration switch — the single control that closes the unsigned hole.
// ---------------------------------------------------------------------------
{
  const legacy = 'oneteam-user:usr-merch-003';

  const honoured = verifyServiceCredential(legacy, { signingSecret: SECRET, allowLegacy: true });
  check('a legacy token is honoured while allowLegacy is true', honoured?.userId === 'usr-merch-003');
  check('and is reported as NOT signed', honoured?.signed === false, honoured);

  const refused = verifyServiceCredential(legacy, { signingSecret: SECRET, allowLegacy: false });
  check('the same legacy token is refused once allowLegacy is false', refused === null, refused);

  check(
    'a legacy token with an empty id is refused even when allowed',
    verifyServiceCredential('oneteam-user:', { signingSecret: null, allowLegacy: true }) === null,
  );

  check(
    'a non-credential string is refused regardless of flags',
    verifyServiceCredential('otd_device_token', { signingSecret: SECRET, allowLegacy: true }) ===
      null,
  );
}

console.log(
  `\n${passed + failed} checks: ${passed} passed${failed > 0 ? `, ${failed} FAILED` : ''}`,
);
process.exit(failed === 0 ? 0 : 1);
