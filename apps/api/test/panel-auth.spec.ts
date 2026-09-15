/**
 * oneTeam — panel authentication suite
 * ============================================================================
 *
 * WHY THIS EXISTS AS A PERMANENT TEST
 * -----------------------------------
 * The supervisor panel had no login. nginx injected `oneteam-user:usr-admin-001`
 * at the edge for every `/api/portal/` request, so the only thing between a
 * stranger and full administrative access was knowing the URL, and every audit
 * in the database was attributed to the same seeded user.
 *
 * Adding a login screen is the easy half. The half that matters — and the one
 * that is easy to get wrong in a way that looks finished — is that the login
 * must not be decorative: if the edge keeps injecting an administrator, then the
 * screen hides the data from the browser and protects nothing. An attacker who
 * typed the API path by hand would still be handed the data.
 *
 * So the load-bearing assertion here is not "a key can be minted". It is:
 *
 *   once a key exists, the edge credential is REFUSED on the supervisor routes.
 *
 * Everything else in this file exists to make sure that refusal is narrow enough
 * to be usable: the panel's own key must still work, the field API the bot and
 * the mobile app use must be untouched, and the open state must come back when
 * the last key is revoked.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * --------------------------------------
 * It runs over HTTP against a running API, because the wiring between the guard
 * and the edge is exactly what is being tested and an in-process test would
 * exercise neither.
 *
 * THE BOOTSTRAP KEY IS NOT COVERED HERE. It is read from the environment at
 * process start, so testing it means restarting the API — see the note at the
 * bottom of this file for the manual procedure.
 *
 * THIS SUITE CLEANS UP AFTER ITSELF, AND THAT IS LOAD-BEARING.
 * It mints keys, and a key left behind would close the supervisor API for every
 * other suite — `bot:test`, `web:test` and `mobile:test` all stand in for a
 * supervisor. Cleanup runs in a `finally`, and the last check asserts that the
 * live-key count is back where it started, so a leaked key fails the suite
 * rather than silently breaking someone else's.
 *
 * Prerequisites: the API must be running, and DATABASE_URL must point at the
 * same database it is using.
 *
 *   npm run api:dev
 *   DATABASE_URL=postgres://... ONETEAM_API_URL=http://localhost:3001 npm run test:panel
 */

import { createHash } from 'node:crypto';
import { Client } from 'pg';

const API_BASE = (process.env.ONETEAM_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || '';
const STORE_CODE = process.env.ONETEAM_TEST_STORE_CODE || 'ARAZ_GENJLIK_02';

/** An administrator service credential — needed to mint the very first key. */
const ADMIN_TOKEN = process.env.ONETEAM_TEST_ADMIN_TOKEN || 'oneteam-user:usr-admin-001';
/** A supervisor, to prove that reading the panel is not the same as running it. */
const SUPERVISOR_USER = process.env.ONETEAM_TEST_SUPERVISOR_USER || 'usr-super-002';

const ENROLLMENT_SECRET = process.env.ONETEAM_ENROLLMENT_SECRET || '';

let pass = 0;
let fail = 0;
let skipped = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    console.log(`  \u2717 ${name}`);
    if (detail !== undefined) console.log(`      got: ${JSON.stringify(detail)}`);
  }
}

function skip(name: string, why: string): void {
  skipped += 1;
  console.log(`  \u25CB ${name} — SKIPPED: ${why}`);
}

interface Result {
  status: number;
  body: any;
}

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Result> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Every key this suite minted, so cleanup cannot miss one. */
const minted: string[] = [];

async function main(): Promise<void> {
  console.log(`\n=== panel authentication suite against ${API_BASE} ===`);

  if (!DATABASE_URL) {
    console.log(
      '\nDATABASE_URL is not set, so the "the key is stored as a hash" checks cannot run.\n' +
        'The HTTP checks will still run.\n',
    );
  }

  const db = DATABASE_URL ? new Client({ connectionString: DATABASE_URL }) : null;
  if (db) await db.connect();

  const query = async (sql: string, params: unknown[] = []): Promise<any[]> => {
    if (!db) throw new Error('no database connection');
    const result = await db.query(sql, params as any[]);
    return result.rows;
  };

  // -------------------------------------------------------------------------
  // Preconditions
  // -------------------------------------------------------------------------
  console.log('\npreconditions');
  try {
    const health = await call('GET', '/api/health');
    check('the API answers /api/health', health.status === 200, health.status);
  } catch (error) {
    console.log(`\n  \u2717 the API is not reachable at ${API_BASE}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
    console.log('\n  Start it with `npm run api:dev` and try again.\n');
    process.exitCode = 1;
    return;
  }

  const before = await call('GET', '/api/panel/auth-status');
  check('GET /api/panel/auth-status is public', before.status === 200, before.status);
  check(
    'it reports a boolean `required`',
    typeof before.body?.data?.required === 'boolean',
    before.body,
  );
  check(
    'it explains itself in a sentence',
    typeof before.body?.data?.detail === 'string' && before.body.data.detail.length > 20,
    before.body?.data?.detail,
  );
  check(
    'a configured key and an open panel are never reported at the same time',
    !(before.body?.data?.required === false && Number(before.body?.data?.liveKeys) > 0),
    before.body?.data,
  );

  const liveKeysBefore = Number(before.body?.data?.liveKeys ?? 0);
  if (liveKeysBefore > 0) {
    console.log(
      `\n  NOTE: the panel already has ${liveKeysBefore} live key(s). This suite will add and ` +
        `remove its own and leave the count as it found it.`,
    );
  }

  // -------------------------------------------------------------------------
  // Who am I, and who is refused
  // -------------------------------------------------------------------------
  console.log('\nidentity');

  const noCredential = await call('GET', '/api/panel/me');
  check('/api/panel/me refuses a request with no credential', noCredential.status === 401);

  // -------------------------------------------------------------------------
  // A panel that is already locked: assert the boundary, then stop
  // -------------------------------------------------------------------------
  // Once a key exists, the service credential this suite holds is refused on the
  // panel's own routes as well as the portal routes — so there is nothing left
  // to mint with and the flow below cannot start.
  //
  // The refusal is the assertion worth making here, and it is a newer one. The
  // guard used to treat `/api/panel/*` as neither supervisor nor field, so
  // `mayUseRoute` returned true before it read the credential: a service
  // credential could mint itself a panel key on a locked panel, and the bot
  // holds exactly that credential. `/api/panel/keys` is the most sensitive route
  // in the system, so it is checked first.
  //
  // The keys found here are NOT cleared. They belong to whoever locked the
  // panel, and revoking them to make a suite pass would be a far worse failure
  // than a skip.
  if (liveKeysBefore > 0) {
    const edgeMintsOnPanel = await call('POST', '/api/panel/keys', {
      token: ADMIN_TOKEN,
      body: { userId: 'usr-admin-001', label: 'the service credential must not mint' },
    });
    check('THE SERVICE CREDENTIAL IS REFUSED ON THE PANEL API', edgeMintsOnPanel.status === 403, {
      status: edgeMintsOnPanel.status,
      body: edgeMintsOnPanel.body,
    });
    check(
      'and the refusal names the panel key',
      edgeMintsOnPanel.body?.error === 'PANEL_KEY_REQUIRED',
      edgeMintsOnPanel.body,
    );

    const edgeReadsOnPanel = await call('GET', '/api/panel/me', { token: ADMIN_TOKEN });
    check('and on /api/panel/me', edgeReadsOnPanel.status === 403, edgeReadsOnPanel.status);

    const edgeOnPortal = await call('GET', '/api/portal/metrics', { token: ADMIN_TOKEN });
    check('and on the supervisor API', edgeOnPortal.status === 403, edgeOnPortal.status);

    skip(
      'the full mint-and-revoke flow',
      `the panel is already locked by ${liveKeysBefore} key(s), so this suite holds no credential it could mint with`,
    );
    console.log(
      '\n  To run the full suite: point it at a database with no live panel keys,\n' +
        '  or set ONETEAM_PANEL_BOOTSTRAP_KEY and restart the API, mint a personal\n' +
        '  key from the panel, then revoke the leftovers.\n',
    );

    if (db) await db.end();
    console.log(`${pass} passed, ${fail} failed, ${skipped} skipped\n`);
    if (fail > 0) process.exitCode = 1;
    return;
  }

  const asAdmin = await call('GET', '/api/panel/me', { token: ADMIN_TOKEN });
  check('an administrator service credential is identified', asAdmin.status === 200, asAdmin.body);
  check(
    'and is told it may manage keys',
    asAdmin.body?.data?.canManageKeys === true,
    asAdmin.body?.data,
  );
  check(
    'and is not mistaken for a signed-in person',
    asAdmin.body?.data?.via !== 'panel',
    asAdmin.body?.data,
  );

  // -------------------------------------------------------------------------
  // The gate closes
  // -------------------------------------------------------------------------
  console.log('\nminting a key, and what that closes');

  const minted1 = await call('POST', '/api/panel/keys', {
    token: ADMIN_TOKEN,
    body: { userId: 'usr-admin-001', label: 'panel suite — admin' },
  });
  check('an administrator can mint a key', minted1.status === 201, minted1.body);

  const adminKey: string = minted1.body?.data?.token ?? '';
  if (adminKey) minted.push(adminKey);

  check('the key has the panel prefix', adminKey.startsWith('otp_'), adminKey.slice(0, 8));
  check('the key is 47 characters', adminKey.length === 47, adminKey.length);

  /**
   * The identifier used to revoke a key is a prefix of its HASH, not of the key.
   *
   * Derived here independently with the same SHA-256 the server uses, rather
   * than taken on trust from the response: if the two ever disagreed, the key
   * list would show a prefix that revokes nothing, and the mistake would look
   * like a working feature.
   */
  const adminHashPrefix = sha256(adminKey).slice(0, 8);
  check(
    'the response identifies the key by the prefix of its hash',
    minted1.body?.data?.hashPrefix === adminHashPrefix,
    { fromApi: minted1.body?.data?.hashPrefix, derived: adminHashPrefix },
  );
  check(
    'and that prefix is not a prefix of the key itself',
    !adminKey.startsWith(adminHashPrefix),
    adminHashPrefix,
  );

  const afterMint = await call('GET', '/api/panel/auth-status');
  check(
    'the panel now reports that a key is required',
    afterMint.body?.data?.required === true,
    afterMint.body?.data,
  );
  check(
    'and the live-key count went up by exactly one',
    Number(afterMint.body?.data?.liveKeys) === liveKeysBefore + 1,
    { before: liveKeysBefore, after: afterMint.body?.data?.liveKeys },
  );

  // THE LOAD-BEARING ASSERTION. Without it the login screen is decoration.
  const edgeOnSupervisorRoute = await call('GET', '/api/portal/metrics', { token: ADMIN_TOKEN });
  check(
    'THE EDGE CREDENTIAL IS REFUSED ON THE SUPERVISOR API',
    edgeOnSupervisorRoute.status === 403,
    { status: edgeOnSupervisorRoute.status, body: edgeOnSupervisorRoute.body },
  );
  check(
    'and the refusal says why, in a code the panel can act on',
    edgeOnSupervisorRoute.body?.error === 'PANEL_KEY_REQUIRED',
    edgeOnSupervisorRoute.body,
  );

  // The same rule, on the panel's own routes. These matter most: `/api/panel/keys`
  // is where keys are minted, so a credential that is refused everywhere else but
  // accepted here would still be a way in — and a quieter one, because it would
  // leave a key behind instead of reading data.
  const edgeMintsOnPanel = await call('POST', '/api/panel/keys', {
    token: ADMIN_TOKEN,
    body: { userId: 'usr-admin-001', label: 'the service credential must not mint' },
  });
  check('THE SERVICE CREDENTIAL IS REFUSED ON THE PANEL API TOO', edgeMintsOnPanel.status === 403, {
    status: edgeMintsOnPanel.status,
    body: edgeMintsOnPanel.body,
  });
  check(
    'and it is refused before the key is written',
    edgeMintsOnPanel.body?.error === 'PANEL_KEY_REQUIRED',
    edgeMintsOnPanel.body,
  );

  const panelOnSupervisorRoute = await call('GET', '/api/portal/metrics', { token: adminKey });
  check(
    "the panel's own key still works on the same route",
    panelOnSupervisorRoute.status === 200,
    panelOnSupervisorRoute.status,
  );

  // -------------------------------------------------------------------------
  // Refusals
  // -------------------------------------------------------------------------
  console.log('\nrefusals');

  const bogus = await call('GET', '/api/portal/metrics', {
    token: 'otp_definitelynotarealkeyatall',
  });
  check('an invented panel key is refused', bogus.status === 401, bogus.status);

  const oversized = await call('GET', '/api/panel/me', { token: `otp_${'x'.repeat(600)}` });
  check('an absurdly long key is refused without reaching the database', oversized.status === 401);

  const deviceCredentialOnSupervisor = await call('GET', '/api/portal/metrics', {
    token: 'otd_notarealdevicetoken',
  });
  check(
    'a device credential is refused on the supervisor API',
    deviceCredentialOnSupervisor.status === 401,
    deviceCredentialOnSupervisor.status,
  );

  // -------------------------------------------------------------------------
  // The field API is untouched
  // -------------------------------------------------------------------------
  console.log('\nthe field API the bot and the mobile app use');

  const fieldWithService = await call('GET', '/api/portal/field/whoami', { token: ADMIN_TOKEN });
  check(
    'a service credential still reaches the field API',
    fieldWithService.status === 200,
    fieldWithService.status,
  );
  check(
    'and the field API reports how it was reached',
    fieldWithService.body?.data?.via === 'service',
    fieldWithService.body?.data,
  );

  const fieldWithPanelKey = await call('GET', '/api/portal/field/whoami', { token: adminKey });
  check(
    'a panel key also reaches the field API — it is not a wall, it is a scope',
    fieldWithPanelKey.status === 200,
    fieldWithPanelKey.status,
  );

  // -------------------------------------------------------------------------
  // Reading the panel is not running it
  // -------------------------------------------------------------------------
  console.log('\nadministrator-only surface');

  const mintedSupervisor = await call('POST', '/api/panel/keys', {
    token: adminKey,
    body: { userId: SUPERVISOR_USER, label: 'panel suite — supervisor' },
  });
  check(
    'an administrator can mint a key for somebody else',
    mintedSupervisor.status === 201,
    mintedSupervisor.body,
  );

  const supervisorKey: string = mintedSupervisor.body?.data?.token ?? '';
  if (supervisorKey) minted.push(supervisorKey);
  const supervisorHashPrefix = sha256(supervisorKey).slice(0, 8);

  const supervisorReads = await call('GET', '/api/portal/metrics', { token: supervisorKey });
  check(
    'a supervisor can read the supervisor API',
    supervisorReads.status === 200,
    supervisorReads.status,
  );

  const supervisorMints = await call('POST', '/api/panel/keys', {
    token: supervisorKey,
    body: { userId: SUPERVISOR_USER, label: 'nope' },
  });
  check(
    'but a supervisor cannot mint a key',
    supervisorMints.status === 403,
    supervisorMints.status,
  );
  check(
    'and the refusal is specific',
    supervisorMints.body?.error === 'ADMIN_REQUIRED',
    supervisorMints.body,
  );

  const supervisorListsKeys = await call('GET', '/api/panel/keys', { token: supervisorKey });
  check('nor list the keys', supervisorListsKeys.status === 403, supervisorListsKeys.status);

  // -------------------------------------------------------------------------
  // The key list
  // -------------------------------------------------------------------------
  console.log('\nthe key list');

  const list = await call('GET', '/api/panel/keys', { token: adminKey });
  check('an administrator can list keys', list.status === 200, list.status);

  const rows: any[] = list.body?.data?.keys ?? [];
  check('the list contains the keys just minted', rows.length >= 2, rows.length);
  check(
    'no row contains a full hash',
    rows.every((row) => typeof row.hashPrefix === 'string' && row.hashPrefix.length === 8),
    rows.map((row) => row.hashPrefix),
  );
  check(
    'exactly one row is marked as the current session',
    rows.filter((row) => row.current).length === 1,
    rows.filter((row) => row.current).length,
  );
  check(
    'the current row is the key that made the request',
    rows.find((row) => row.current)?.hashPrefix === adminHashPrefix,
    { listed: rows.find((row) => row.current)?.hashPrefix, expected: adminHashPrefix },
  );
  check(
    'the list offers the people a key could be issued to',
    Array.isArray(list.body?.data?.users) && list.body.data.users.length > 0,
  );

  // -------------------------------------------------------------------------
  // Storage of the credential
  // -------------------------------------------------------------------------
  console.log('\nhow the key is stored');

  if (!db) {
    skip('the stored value is the hash and not the key', 'DATABASE_URL is not set');
    skip('the raw key appears nowhere in the table', 'DATABASE_URL is not set');
  } else {
    const byHash = await query(
      'SELECT user_id, revoked_at FROM panel_tokens WHERE token_hash = $1',
      [sha256(adminKey)],
    );
    check('a row exists under sha256(key)', byHash.length === 1, byHash.length);
    check('and it belongs to the right user', byHash[0]?.user_id === 'usr-admin-001', byHash[0]);
    check('and it is live', byHash[0]?.revoked_at === null, byHash[0]?.revoked_at);

    const raw = await query('SELECT count(*)::int AS n FROM panel_tokens WHERE token_hash = $1', [
      adminKey,
    ]);
    check('the raw key is not stored as the hash', Number(raw[0]?.n) === 0, raw[0]);

    const prefixed = await query(
      "SELECT count(*)::int AS n FROM panel_tokens WHERE token_hash LIKE 'otp_%'",
      [],
    );
    check(
      "no row holds a value in the key's own format",
      Number(prefixed[0]?.n) === 0,
      prefixed[0],
    );
  }

  // -------------------------------------------------------------------------
  // Revocation
  // -------------------------------------------------------------------------
  console.log('\nrevocation');

  const revokeSelf = await call('POST', `/api/panel/keys/${adminHashPrefix}/revoke`, {
    token: adminKey,
  });
  check('revoking your own current key is refused', revokeSelf.status === 400, {
    status: revokeSelf.status,
    body: revokeSelf.body,
  });
  check(
    'and points at the sign-out button instead',
    revokeSelf.body?.error === 'CANNOT_REVOKE_OWN_SESSION',
    revokeSelf.body,
  );

  const revokeSupervisor = await call('POST', `/api/panel/keys/${supervisorHashPrefix}/revoke`, {
    token: adminKey,
  });
  check(
    "revoking somebody else's key works",
    revokeSupervisor.status === 200 && revokeSupervisor.body?.data?.revoked === true,
    revokeSupervisor.body,
  );

  const afterRevoke = await call('GET', '/api/portal/metrics', { token: supervisorKey });
  check('and that key stops working immediately', afterRevoke.status === 401, afterRevoke.status);

  const ambiguous = await call('POST', '/api/panel/keys/otp/revoke', { token: adminKey });
  check(
    'a prefix too short to identify a key is refused',
    ambiguous.status === 400,
    ambiguous.status,
  );

  if (db) {
    const row = await query('SELECT revoked_at FROM panel_tokens WHERE token_hash = $1', [
      sha256(supervisorKey),
    ]);
    check('the revoked row is kept, not deleted', row.length === 1, row.length);
    check('and it carries a revocation timestamp', Boolean(row[0]?.revoked_at), row[0]);
  } else {
    skip('the revoked row is kept, not deleted', 'DATABASE_URL is not set');
  }

  // -------------------------------------------------------------------------
  // The audit trail
  // -------------------------------------------------------------------------
  console.log('\nthe audit trail');

  if (!db) {
    skip('issuing a key is recorded', 'DATABASE_URL is not set');
    skip('the record holds a prefix, not the key', 'DATABASE_URL is not set');
  } else {
    const audit = await query(
      `SELECT action, actor_id, payload
         FROM audit_logs
        WHERE entity_type = 'panel_token'
          AND payload->>'hashPrefix' = $1`,
      [adminHashPrefix],
    );
    check('issuing a key is recorded in audit_logs', audit.length === 1, audit.length);
    check(
      'the record names who issued it',
      audit[0]?.actor_id === 'usr-admin-001',
      audit[0]?.actor_id,
    );
    check(
      'and holds only a prefix, never the key',
      audit[0] !== undefined && !JSON.stringify(audit[0]).includes(adminKey),
      audit[0],
    );
  }

  // -------------------------------------------------------------------------
  // Cleanup — and proof that it worked
  // -------------------------------------------------------------------------
  console.log('\ncleanup');

  // Signing out revokes the presented key, which is the only way to revoke your
  // own — and it is what the panel actually does, so the suite exercises the
  // real path rather than the administrative one.
  const signOut = await call('POST', '/api/panel/logout', { token: adminKey });
  check(
    'signing out revokes the key that was used',
    signOut.status === 200 && signOut.body?.data?.revoked === true,
    signOut.body,
  );

  const afterSignOut = await call('GET', '/api/portal/metrics', { token: adminKey });
  check('and that key no longer works', afterSignOut.status === 401, afterSignOut.status);

  if (db) {
    // Anything else this suite minted and did not get to revoke — a failure
    // part-way through would otherwise leave the panel locked for everyone.
    const stragglers = await query(
      `UPDATE panel_tokens
          SET revoked_at = now()
        WHERE token_hash = ANY($1::text[])
          AND revoked_at IS NULL
      RETURNING token_hash`,
      [minted.map((token) => sha256(token))],
    );
    if (stragglers.length > 0) {
      console.log(`  (revoked ${stragglers.length} key(s) left by an earlier failure)`);
    }

    const live = await query(
      'SELECT count(*)::int AS n FROM panel_tokens WHERE revoked_at IS NULL',
    );
    check(
      'the live-key count is back where the suite found it',
      Number(live[0]?.n) === liveKeysBefore,
      { before: liveKeysBefore, after: live[0]?.n },
    );
  }

  const final = await call('GET', '/api/panel/auth-status');
  check(
    'auth-status is consistent with the key count',
    final.body?.data?.required ===
      (Number(final.body?.data?.liveKeys) > 0 || final.body?.data?.bootstrapConfigured === true),
    final.body?.data,
  );

  if (liveKeysBefore === 0) {
    const reopened = await call('GET', '/api/portal/metrics', { token: ADMIN_TOKEN });
    check('with no keys left, the panel is open again', reopened.status === 200, reopened.status);
  } else {
    skip(
      'with no keys left, the panel is open again',
      `the panel already had ${liveKeysBefore} key(s) before this suite ran`,
    );
  }

  if (db) await db.end();

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error('\nThe suite could not finish:', error);
  // Cleanup even on a crash: a key left behind closes the supervisor API for
  // every other suite, and the next person to run one would have no idea why.
  if (DATABASE_URL && minted.length > 0) {
    try {
      const client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
      const hashes = minted.map((token) => sha256(token));
      await client.query(
        `UPDATE panel_tokens SET revoked_at = now()
          WHERE token_hash = ANY($1::text[]) AND revoked_at IS NULL`,
        [hashes],
      );
      await client.end();
      console.error(`Cleaned up ${hashes.length} key(s) after the crash.`);
    } catch (cleanupError) {
      console.error('Cleanup also failed:', cleanupError);
      console.error('Revoke the keys by hand — see the note in this file.');
    }
  }
  process.exitCode = 1;
});

/**
 * THE BOOTSTRAP KEY IS NOT COVERED ABOVE
 * --------------------------------------
 * It is read from the environment when the process starts, so exercising it
 * means restarting the API. The procedure below has been run, and every line of
 * it passed — including the two cases that were WRONG the first time.
 *
 *   # 1. A strong key is accepted, and signs in as the bootstrap user.
 *   export K="$(openssl rand -base64 24)"
 *   ONETEAM_PANEL_BOOTSTRAP_KEY="$K" npm run api:dev
 *   curl -s $API/api/panel/auth-status      # required true, liveKeys 0, configured true
 *   curl -s -H "Authorization: Bearer $K" $API/api/panel/me
 *        # -> userId usr-admin-001, via "panel", usingBootstrapKey true
 *   curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $K" $API/api/portal/metrics   # 200
 *   curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer oneteam-user:usr-admin-001" \
 *        $API/api/portal/metrics            # 403 — the edge credential is refused
 *   # and it can mint the personal key that replaces it:
 *   curl -s -X POST -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
 *        -d '{"userId":"usr-admin-001","label":"bootstrap"}' $API/api/panel/keys
 *   curl -s -X POST -H "Authorization: Bearer $K" $API/api/panel/logout
 *        # -> {"revoked":false,"bootstrap":true} — there is no row to revoke, and
 *        #    the response says so rather than pretending something changed
 *
 *   # 2. A short key is REFUSED rather than accepted as a guessable master key.
 *   #    Note it fails CLOSED: the panel is locked, not quietly left open.
 *   ONETEAM_PANEL_BOOTSTRAP_KEY=short npm run api:dev
 *        # start-up: "ONETEAM_PANEL_BOOTSTRAP_KEY is only 4 characters…"
 *   curl -s $API/api/panel/auth-status      # bootstrapProblem is set, configured false
 *   curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer short" $API/api/panel/me   # 401
 *   curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer oneteam-user:usr-admin-001" \
 *        $API/api/portal/metrics            # 403, not 200
 *
 *   # 3. A key shaped like another credential is refused, because it would be
 *   #    routed as that credential by every reader but one.
 *   ONETEAM_PANEL_BOOTSTRAP_KEY='oneteam-user:usr-admin-001' npm run api:dev
 *        # start-up: begins with "oneteam-user:", which is how the service
 *        #           credential is recognised
 *
 * WHY CASE 1 IS WRITTEN DOWN IN THIS MUCH DETAIL
 * ----------------------------------------------
 * It was broken, and it failed silently in the worst possible way. The guard
 * routed bearers by prefix, and the bootstrap key has no prefix — it is a value
 * the operator typed. So the key fell through to the user-id branch, was read as
 * a malformed user id, and was answered 401. Meanwhile `/api/panel/auth-status`
 * reported `bootstrapConfigured: true`, because that flag only asks whether the
 * variable is set. The panel said it was configured, showed a login screen, and
 * nothing could open it.
 *
 * The fix is in `resolveBearer`: the bootstrap key is recognised by comparison,
 * not by shape. The lesson is the one this whole file keeps repeating — a flag
 * that says a credential is configured is not evidence that it works, and only
 * presenting it can tell you.
 */
