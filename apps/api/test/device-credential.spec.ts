/**
 * oneTeam — device credential suite
 * ============================================================================
 *
 * WHY THIS EXISTS AS A PERMANENT TEST
 * -----------------------------------
 * The mobile app used to ship a shared service credential that defaulted to an
 * administrator. It now enrols and holds a device token that resolves to exactly
 * one user. The thing that makes that worth doing is not the token, it is the
 * REFUSAL: a device credential must not be able to name another installation.
 *
 * That refusal was broken during development, silently. `AuthGuard` built the
 * device principal by calling the same helper the service credential uses, which
 * stamped it `via: 'service'`, and `enforceActorScope` — reading that field —
 * waved a device token through that named a foreign device and created a user
 * for it. The code compiled, the happy paths passed, and nothing noticed. A
 * security boundary that has already failed once without a red test must have
 * one that goes red if it fails again.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * --------------------------------------
 * It runs over HTTP against a running API, because the bug was in the wiring
 * between the guard and the controller and an in-process test would have
 * exercised neither. So it is a LIVE test, like `bot:test` and `mobile:test`.
 *
 * The load-bearing assertions are the refusals. A suite that only checked that
 * enrolment returns a token would pass against an API that authorises anything.
 *
 * It also guards the enrolment path itself, because that is where credentials are
 * created out of nothing and it has now failed in three different ways. A burst
 * of first-time enrolments must not lose its writes (they used to race, and a
 * lost credential surfaced as a bare 500), a store code must not be replayable
 * into an unbounded supply of identities (it was, and only failures were
 * rate-limited), and the store lookup the login screen makes BEFORE it has a
 * credential must be reachable without one (it was not, so no fresh install
 * could sign in at all — see the section below). Both are covered below.
 *
 * It also asserts the opposite direction: the service credential MUST still be
 * able to name any user, because that is what lets the Telegram bot act for
 * whichever chat an update came from. A "fix" that locked both credentials down
 * would break the bot and still pass every refusal check here — which is why the
 * asymmetry is asserted rather than assumed.
 *
 * Prerequisites: the API must be running, and DATABASE_URL must point at the
 * same database it is using.
 *
 *   npm run api:dev
 *   DATABASE_URL=postgres://... ONETEAM_API_URL=http://localhost:3001 npm run test:device
 */

import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { serviceToken } from './helpers/service-token';

const API_BASE = (process.env.ONETEAM_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || '';
const STORE_CODE = process.env.ONETEAM_TEST_STORE_CODE || 'BRAVO_YASAMAL_01';
const SERVICE_TOKEN = process.env.ONETEAM_TEST_SERVICE_TOKEN || serviceToken('usr-merch-003');

/** The enrolment second factor, when the API under test requires one. */
const ENROLLMENT_SECRET = process.env.ONETEAM_ENROLLMENT_SECRET || '';

/**
 * The store the new-installation cap is exercised against.
 *
 * A store of its own on purpose. The cap is per store and per window, so a test
 * that spent the main store's budget would start refusing the suite's *other*
 * enrolments — the check would take out the checks around it. This store has no
 * other purpose, so spending its budget is the test's business and nobody
 * else's.
 */
const CAP_STORE_CODE = process.env.ONETEAM_TEST_CAP_STORE_CODE || 'BAZAR_PORTBAKU_03';

/**
 * The cap the API under test is running with.
 *
 * Read from the same variable the API reads, so a run against an API started
 * with a smaller cap still measures the right number instead of guessing.
 */
const NEW_DEVICE_CAP = Number(process.env.ONETEAM_ENROLLMENT_MAX_NEW_DEVICES) || 30;

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

/**
 * A check that could not run.
 *
 * Reported separately from a pass and from a failure, because pretending a
 * skipped assertion passed is how a suite becomes decorative. The only thing
 * that skips today is the rate limit: the API counts enrolment failures per
 * address, so a run repeated many times in fifteen minutes exhausts its own
 * budget and the failure-path checks cannot be exercised.
 */
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
  options: { token?: string; body?: unknown; secret?: string } = {},
): Promise<Result> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.secret !== undefined) headers['X-Enrollment-Secret'] = options.secret;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let body: any;
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

function enrollBody(deviceId: string, overrides: Record<string, unknown> = {}) {
  return {
    storeCode: STORE_CODE,
    fullName: 'Credential Suite Device',
    deviceId,
    ...(ENROLLMENT_SECRET ? { enrollmentSecret: ENROLLMENT_SECRET } : {}),
    ...overrides,
  };
}

async function main(): Promise<void> {
  console.log(`\n=== device credential suite against ${API_BASE} ===`);

  if (!DATABASE_URL) {
    console.log(
      '\nDATABASE_URL is not set, so the storage-of-the-credential checks cannot run.\n' +
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
  // Is the API there at all?
  // -------------------------------------------------------------------------
  console.log('\npreconditions');
  try {
    const health = await call('GET', '/api/health');
    check('the API answers', health.status === 200, health);
  } catch (error) {
    // `cause` is what preserves the original failure. The message below is for a
    // person reading the terminal; the cause is for whoever has to find out
    // whether the API was down, listening on another port, or refusing the
    // connection — three problems with three different fixes.
    throw new Error(
      `The API at ${API_BASE} is not answering (${
        error instanceof Error ? error.message : String(error)
      }).\n       Start it with: npm run api:dev`,
      { cause: error },
    );
  }

  // Does this deployment require the second factor? Asked rather than assumed,
  // so the suite works against a pilot deployment and a hardened one.
  //
  // Named rather than inline because this probe enrols for real when the second
  // factor is not required, and the installation it creates has to be cleaned up
  // with the rest — see `createdDeviceIds`.
  const PROBE_DEVICE_ID = 'dev-probe-' + Date.now();
  const probe = await call('POST', '/api/portal/field/enroll', {
    body: { storeCode: STORE_CODE, fullName: 'Probe', deviceId: PROBE_DEVICE_ID },
  });
  const secretRequired = probe.status === 401 && probe.body?.error === 'ENROLLMENT_SECRET_REQUIRED';
  console.log(
    `  \u2139 enrolment second factor: ${
      secretRequired
        ? ENROLLMENT_SECRET
          ? 'required and configured'
          : 'REQUIRED BUT NOT CONFIGURED — set ONETEAM_ENROLLMENT_SECRET'
        : 'not required'
    }`,
  );

  if (secretRequired && !ENROLLMENT_SECRET) {
    throw new Error(
      'The API requires ONETEAM_ENROLLMENT_SECRET and the suite does not have it.\n' +
        '       Export the same value the API was started with.',
    );
  }

  // -------------------------------------------------------------------------
  // The lookup that happens BEFORE there is a credential
  // -------------------------------------------------------------------------
  //
  // The login screen resolves the store, checks the device is really inside it,
  // and only then enrols — because enrolling claims the store's open work. So
  // the FIRST call of the FIRST sign-in has to work with no credential at all.
  //
  // It did not. The screen called the authenticated `field/store`, `callApi`
  // refuses to send a request with no token, and every fresh installation failed
  // with "Sistemə qoşulmaq mümkün olmadı" whatever the store code was. Nothing
  // caught it: the CI UI test only drives the rejection path, and the full-flow
  // test is skipped without a backend. These assertions are what would have.
  //
  // The pair matters. Asserting only that the anonymous lookup works would pass
  // against an API that had simply dropped the guard from the authenticated
  // route as well.
  console.log('\nthe store lookup that precedes enrolment');

  const anonymousLookup = await call(
    'GET',
    `/api/portal/field/store-lookup?code=${encodeURIComponent(STORE_CODE)}`,
    ENROLLMENT_SECRET ? { secret: ENROLLMENT_SECRET } : {},
  );
  check(
    'the pre-enrolment store lookup answers with no credential',
    anonymousLookup.status === 200,
    anonymousLookup,
  );
  check(
    'and it names the store the code refers to',
    anonymousLookup.body?.data?.store_code === STORE_CODE,
    anonymousLookup.body?.data,
  );
  check(
    'and it carries the coordinates the geofence check needs',
    typeof anonymousLookup.body?.data?.latitude === 'number' &&
      typeof anonymousLookup.body?.data?.longitude === 'number',
    anonymousLookup.body?.data,
  );

  const authenticatedLookup = await call(
    'GET',
    `/api/portal/field/store?code=${encodeURIComponent(STORE_CODE)}`,
  );
  check(
    'the authenticated store route still refuses a caller with no credential',
    authenticatedLookup.status === 401,
    authenticatedLookup,
  );

  const lookupNoCode = await call(
    'GET',
    '/api/portal/field/store-lookup',
    ENROLLMENT_SECRET ? { secret: ENROLLMENT_SECRET } : {},
  );
  check('a lookup with no code is refused with 400', lookupNoCode.status === 400, lookupNoCode);

  const lookupBadCode = await call(
    'GET',
    '/api/portal/field/store-lookup?code=NO_SUCH_STORE_99',
    ENROLLMENT_SECRET ? { secret: ENROLLMENT_SECRET } : {},
  );
  if (lookupBadCode.status === 429) {
    skip('a lookup for an unknown code is refused with 404', 'failure window exhausted');
  } else {
    check(
      'a lookup for an unknown code is refused with 404',
      lookupBadCode.status === 404,
      lookupBadCode,
    );
  }

  if (ENROLLMENT_SECRET) {
    // The lookup must not be the cheap way round the second factor. If it were
    // reachable without the secret it would be a store-code enumeration oracle
    // sitting next to an enrolment that is not.
    const lookupNoSecret = await call(
      'GET',
      `/api/portal/field/store-lookup?code=${encodeURIComponent(STORE_CODE)}`,
    );
    check(
      'the lookup demands the enrolment secret when one is configured',
      lookupNoSecret.status === 401,
      lookupNoSecret,
    );

    const lookupWrongSecret = await call(
      'GET',
      `/api/portal/field/store-lookup?code=${encodeURIComponent(STORE_CODE)}`,
      { secret: 'not-the-secret' },
    );
    check(
      'and a wrong secret is refused the same way',
      lookupWrongSecret.status === 401,
      lookupWrongSecret,
    );
  } else {
    skip(
      'the lookup demands the enrolment secret when one is configured',
      'this API has no ONETEAM_ENROLLMENT_SECRET set',
    );
  }

  // -------------------------------------------------------------------------
  // Enrolment validation
  // -------------------------------------------------------------------------
  console.log('\nenrolment validation');

  const noDevice = await call('POST', '/api/portal/field/enroll', {
    body: { storeCode: STORE_CODE, fullName: 'No Device' },
  });
  check('a missing deviceId is refused with 400', noDevice.status === 400, noDevice);

  const noName = await call('POST', '/api/portal/field/enroll', {
    body: { storeCode: STORE_CODE, deviceId: 'dev-noname' },
  });
  check('a missing fullName is refused with 400', noName.status === 400, noName);

  const badStore = await call('POST', '/api/portal/field/enroll', {
    body: enrollBody('dev-badstore', { storeCode: 'NO_SUCH_STORE_99' }),
  });
  if (badStore.status === 429) {
    skip('an unknown store code is refused with 404', 'enrolment failure window exhausted');
  } else {
    check('an unknown store code is refused with 404', badStore.status === 404, badStore);
  }

  // -------------------------------------------------------------------------
  // The credential that is issued
  // -------------------------------------------------------------------------
  console.log('\nthe issued credential');

  const DEVICE_ID = 'dev-credential-suite';
  const enrolled = await call('POST', '/api/portal/field/enroll', {
    body: enrollBody(DEVICE_ID),
  });
  check('a valid enrolment returns 200', enrolled.status === 200, enrolled);

  const token: string | undefined = enrolled.body?.data?.token;
  const userId: string | undefined = enrolled.body?.data?.userId;
  check(
    'the token carries the device prefix',
    typeof token === 'string' && token.startsWith('otd_'),
    token,
  );
  check(
    'the token is long enough not to be guessable',
    typeof token === 'string' && token.length >= 40,
    token?.length,
  );
  check(
    'the response names the store',
    enrolled.body?.data?.store?.storeCode === STORE_CODE,
    enrolled.body?.data?.store,
  );
  check('the response names the user', typeof userId === 'string', userId);

  if (!token || !userId) {
    throw new Error('Enrolment did not return a token and a user id; the rest cannot run.');
  }

  if (db) {
    const rows = await query(
      `SELECT token_hash, user_id, device_id, revoked_at
         FROM device_tokens WHERE device_id = $1 AND revoked_at IS NULL`,
      [DEVICE_ID],
    );
    check('exactly one live token exists for the device', rows.length === 1, rows.length);
    check(
      'the stored key is the SHA-256 of the token, not the token',
      rows[0]?.token_hash === sha256(token),
      { stored: rows[0]?.token_hash?.slice(0, 16), expected: sha256(token).slice(0, 16) },
    );
    check('the token itself is nowhere in the table', rows[0]?.token_hash !== token, true);
    check(
      'the live token belongs to the enrolled user',
      rows[0]?.user_id === userId,
      rows[0]?.user_id,
    );

    const audit = await query(
      `SELECT payload FROM audit_logs
        WHERE action = 'DEVICE_ENROLLED' AND payload->>'deviceId' = $1
        ORDER BY created_at DESC LIMIT 1`,
      [DEVICE_ID],
    );
    check('the enrolment was written to the audit log', audit.length === 1, audit.length);
    check(
      'the audit log records only a token prefix, never the token',
      Boolean(audit[0]) &&
        String(audit[0].payload?.tokenPrefix ?? '').length === 8 &&
        !JSON.stringify(audit[0].payload).includes(token),
      audit[0]?.payload,
    );
  } else {
    skip('the credential is stored as a hash', 'DATABASE_URL not set');
  }

  // -------------------------------------------------------------------------
  // What the device credential may do
  // -------------------------------------------------------------------------
  console.log('\nthe device credential — its own installation');

  const ownSession = await call(
    'GET',
    `/api/portal/field/session?deviceId=${encodeURIComponent(DEVICE_ID)}`,
    { token },
  );
  check('it reads its own session', ownSession.status === 200, ownSession);
  check(
    'the session resolves to the enrolled user',
    ownSession.body?.data?.userId === userId,
    ownSession.body?.data,
  );

  const ownSubmissions = await call(
    'GET',
    `/api/portal/field/submissions?deviceId=${encodeURIComponent(DEVICE_ID)}`,
    { token },
  );
  check('it reads its own submissions', ownSubmissions.status === 200, ownSubmissions);

  // -------------------------------------------------------------------------
  // What the device credential may NOT do — the point of the whole design
  // -------------------------------------------------------------------------
  console.log('\nthe device credential — refusing to be someone else');

  // Unique per run. A fixed id would make "no user was created for the device it
  // tried to name" pass once and fail forever after, because the first run
  // against a broken build leaves the row behind. A test that cannot be run
  // twice is a test that will be ignored the second time.
  const FOREIGN_DEVICE = `dev-foreign-${Date.now()}`;

  const foreignDevice = await call(
    'GET',
    `/api/portal/field/session?deviceId=${encodeURIComponent(FOREIGN_DEVICE)}`,
    { token },
  );
  check('naming another deviceId is refused with 403', foreignDevice.status === 403, foreignDevice);
  check(
    'the refusal is identified as ACTOR_SCOPE_VIOLATION',
    (foreignDevice.body?.error ?? foreignDevice.body?.message?.error) === 'ACTOR_SCOPE_VIOLATION',
    foreignDevice.body,
  );

  const chatIdAttempt = await call('GET', '/api/portal/field/session?chatId=999888777', { token });
  check('naming a chatId is refused with 403', chatIdAttempt.status === 403, chatIdAttempt);

  const bindForeign = await call('POST', '/api/portal/field/bind', {
    token,
    body: { deviceId: FOREIGN_DEVICE, fullName: 'Intruder' },
  });
  check(
    'bind naming another deviceId is refused with 403',
    bindForeign.status === 403,
    bindForeign,
  );

  const ackForeign = await call('POST', '/api/portal/field/tasks/any-task/acknowledge', {
    token,
    body: { deviceId: FOREIGN_DEVICE },
  });
  check(
    'acknowledge naming another deviceId is refused with 403',
    ackForeign.status === 403,
    ackForeign,
  );

  if (db) {
    const intruder = await query(`SELECT id FROM users WHERE mobile_device_id = $1`, [
      FOREIGN_DEVICE,
    ]);
    check(
      'no user was created for the device it tried to name',
      intruder.length === 0,
      intruder.length,
    );
  }

  // -------------------------------------------------------------------------
  // Presign is open to a device — the one place the actor scope is relaxed
  // -------------------------------------------------------------------------
  // Every check above proves a device is boxed into its own installation. This
  // one proves the single deliberate exception: `POST photos/presign` dropped
  // `requireServiceActor` so the phone can move its photo off the API body
  // (plan §3.1, step 3). The regression that would matter is a silent return of
  // the gate — the device getting the same 403/ACTOR_SCOPE_VIOLATION as above.
  // So the check is precisely "not that": a real answer is 201 (a bucket is
  // configured and it minted a URL) or 503 STORAGE_NOT_CONFIGURED (inline mode);
  // either is fine, a 403 is the failure.
  console.log('\npresign is open to a device credential');

  const devicePresign = await call('POST', '/api/portal/field/photos/presign', {
    token,
    body: { contentType: 'image/jpeg', scope: 'audits/regression' },
  });
  check(
    'a device may presign — it is NOT refused with 403',
    devicePresign.status !== 403,
    devicePresign,
  );
  check(
    'presign answers either 201 (minted) or 503 (no bucket), never the actor gate',
    devicePresign.status === 201 || devicePresign.status === 503,
    devicePresign,
  );
  if (devicePresign.status === 201) {
    check(
      'a minted presign carries an uploadUrl and a publicUrl',
      typeof devicePresign.body?.data?.uploadUrl === 'string' &&
        typeof devicePresign.body?.data?.publicUrl === 'string',
      devicePresign.body?.data,
    );
  } else {
    check(
      'the no-bucket answer is identified as STORAGE_NOT_CONFIGURED',
      (devicePresign.body?.error ?? devicePresign.body?.message?.error) ===
        'STORAGE_NOT_CONFIGURED',
      devicePresign.body,
    );
  }

  const anonPresign = await call('POST', '/api/portal/field/photos/presign', {
    body: { contentType: 'image/jpeg' },
  });
  check(
    'presign still requires a credential — no token is 401',
    anonPresign.status === 401,
    anonPresign,
  );

  // -------------------------------------------------------------------------
  // Unknown, revoked, and laundered tokens
  // -------------------------------------------------------------------------
  console.log('\nunknown and revoked tokens');

  const unknown = await call(
    'GET',
    `/api/portal/field/session?deviceId=${encodeURIComponent(DEVICE_ID)}`,
    { token: 'otd_' + 'a'.repeat(64) },
  );
  check('an unknown device token is refused with 401', unknown.status === 401, unknown);

  const missing = await call(
    'GET',
    `/api/portal/field/session?deviceId=${encodeURIComponent(DEVICE_ID)}`,
  );
  check('no token at all is refused with 401', missing.status === 401, missing);

  // The shape decides which table is consulted, so a device token cannot be
  // reinterpreted as a user id by prefixing it.
  const laundered = await call(
    'GET',
    `/api/portal/field/session?deviceId=${encodeURIComponent(DEVICE_ID)}`,
    { token: `oneteam-user:${token}` },
  );
  check(
    'a device token cannot be laundered through the service prefix',
    laundered.status === 401,
    laundered,
  );

  if (db) {
    // Revocation is tested the way it would be used: issue, use, revoke, and
    // confirm the same token stops working. Checking only that `revoked_at` was
    // written would prove the row changed, not that the credential died.
    await query(`UPDATE device_tokens SET revoked_at = now() WHERE token_hash = $1`, [
      sha256(token),
    ]);

    const rows = await query(`SELECT revoked_at FROM device_tokens WHERE token_hash = $1`, [
      sha256(token),
    ]);
    check('revocation keeps the row rather than deleting it', rows.length === 1, rows.length);

    const afterRevoke = await call(
      'GET',
      `/api/portal/field/session?deviceId=${encodeURIComponent(DEVICE_ID)}`,
      { token },
    );
    check('the revoked token is refused with 401', afterRevoke.status === 401, afterRevoke);

    const writeAfterRevoke = await call('POST', '/api/portal/field/bind', {
      token,
      body: { deviceId: DEVICE_ID, fullName: 'Should Not Work' },
    });
    check('a revoked token cannot write either', writeAfterRevoke.status === 401, writeAfterRevoke);

    // Re-enrolling the same installation must mint a working token. The partial
    // unique index allows one live row per device, so the implementation revokes
    // then inserts — a bare INSERT here would fail with a unique violation.
    const reEnrolled = await call('POST', '/api/portal/field/enroll', {
      body: enrollBody(DEVICE_ID),
    });
    const newToken: string | undefined = reEnrolled.body?.data?.token;
    check(
      're-enrolment issues a different token',
      Boolean(newToken) && newToken !== token,
      newToken,
    );
    check(
      'the old token stays revoked',
      (await call('GET', `/api/portal/field/session?deviceId=${DEVICE_ID}`, { token })).status ===
        401,
    );

    if (newToken) {
      const newWorks = await call('GET', `/api/portal/field/session?deviceId=${DEVICE_ID}`, {
        token: newToken,
      });
      check('the new token works', newWorks.status === 200, newWorks);
    }

    const live = await query(
      `SELECT count(*)::int AS n FROM device_tokens WHERE device_id = $1 AND revoked_at IS NULL`,
      [DEVICE_ID],
    );
    check('exactly one live token remains for the device', live[0]?.n === 1, live[0]?.n);
  } else {
    skip('revocation refuses the token', 'DATABASE_URL not set');
  }

  // -------------------------------------------------------------------------
  // The other direction — the bot must be unaffected
  // -------------------------------------------------------------------------
  console.log('\nthe service credential — the bot must be unaffected');

  const serviceChat = await call('GET', '/api/portal/field/session?chatId=999888777', {
    token: SERVICE_TOKEN,
  });
  check(
    'the service credential may still name an arbitrary chatId',
    serviceChat.status === 200,
    serviceChat,
  );

  const serviceDevice = await call('GET', '/api/portal/field/session?deviceId=any-device-at-all', {
    token: SERVICE_TOKEN,
  });
  check(
    'the service credential may still name an arbitrary deviceId',
    serviceDevice.status === 200,
    serviceDevice,
  );

  // -------------------------------------------------------------------------
  // A burst of first-time enrolments must not lose its writes
  // -------------------------------------------------------------------------
  console.log('\na burst of first-time enrolments');

  // Every one of these is a NEW installation, so each queues four writes at
  // once: the `users` row it is about to become, the claim on the store's open
  // work, the audit entry, and the credential itself.
  //
  // Those writes used to run concurrently, and the ones that lost the race were
  // the ones nobody looks at: a claim reported in the response but absent from
  // the database, an enrolment missing from the audit trail, and — because the
  // credential was the only write the caller awaited — a foreign-key violation
  // that reached the phone as a bare HTTP 500. Measured against the unfixed API:
  // two of five requests. Intermittent, load-dependent, and blamed on the
  // network. This is the regression test for the write queue.
  const stamp = Date.now();
  const burst: Array<{ deviceId: string; status: number; token?: string }> = [];
  for (let i = 0; i < 6; i += 1) {
    const deviceId = `dev-order-${stamp}-${i}`;
    const result = await call('POST', '/api/portal/field/enroll', {
      body: {
        storeCode: STORE_CODE,
        fullName: `Order Probe ${i}`,
        deviceId,
        enrollmentSecret: ENROLLMENT_SECRET || undefined,
      },
    });
    burst.push({ deviceId, status: result.status, token: result.body?.data?.token });
  }

  const accepted = burst.filter((entry) => entry.status === 200);
  const serverErrors = burst.filter((entry) => entry.status >= 500);

  /**
   * Every installation this run created, so it can be removed again at the end.
   *
   * Exercising the cap means creating `cap` installations, and the burst adds
   * six more. Without this the suite left them behind — one session's runs put
   * 184 rows in the development database. The window that counts them is
   * per-process, so deleting them does not restore the budget and the next run
   * skips the same assertions it would have skipped anyway; the only thing
   * cleanup changes is that the mess is not left for someone else.
   */
  const createdDeviceIds: string[] = accepted.map((entry) => entry.deviceId);

  // The precondition probe enrols for real whenever the second factor is not
  // required, so it leaves an installation of its own. It used to be untracked,
  // which is why every run of this suite left one `dev-probe-*` row behind —
  // four runs, four rows, found by counting `users` before and after. Restoring
  // the leak and re-running leaves exactly one, which is how this was checked.
  if (probe.status === 200) createdDeviceIds.push(PROBE_DEVICE_ID);

  if (accepted.length === 0) {
    skip(
      'a burst of first-time enrolments produces no server error',
      `${STORE_CODE} has no new-installation budget left — restart the API to reset it`,
    );
  } else {
    check(
      'a burst of first-time enrolments produces no server error',
      serverErrors.length === 0,
      serverErrors,
    );
  }

  // A token that was returned but never stored is the failure this catches: the
  // response said the device was enrolled and the credential did not exist.
  const brokenTokens: string[] = [];
  for (const entry of accepted) {
    if (!entry.token) {
      brokenTokens.push(`${entry.deviceId}: no token in the response`);
      continue;
    }
    const who = await call('GET', '/api/portal/field/whoami', { token: entry.token });
    if (who.status !== 200) brokenTokens.push(`${entry.deviceId}: whoami answered ${who.status}`);
  }
  if (accepted.length === 0) {
    skip('every accepted enrolment was handed a working credential', 'none were accepted');
  } else {
    check(
      'every accepted enrolment was handed a working credential',
      brokenTokens.length === 0,
      brokenTokens,
    );
  }

  if (!db) {
    skip('every accepted enrolment is in the audit trail', 'DATABASE_URL not set');
  } else if (accepted.length === 0) {
    skip('every accepted enrolment is in the audit trail', 'none were accepted');
  } else {
    const rows = await query(
      `SELECT payload->>'deviceId' AS device_id FROM audit_logs
        WHERE action = 'DEVICE_ENROLLED' AND payload->>'deviceId' = ANY($1)`,
      [accepted.map((entry) => entry.deviceId)],
    );
    const recorded = new Set(rows.map((row) => row.device_id));
    const missing = accepted
      .filter((entry) => !recorded.has(entry.deviceId))
      .map((entry) => entry.deviceId);
    check('every accepted enrolment is in the audit trail', missing.length === 0, missing);
  }

  // -------------------------------------------------------------------------
  // A store code is replayable, so new installations are bounded
  // -------------------------------------------------------------------------
  console.log('\nthe new-installation cap');

  // A store code does not get used up. Before this cap existed it could be
  // presented again and again with a different `deviceId`, and each presentation
  // produced another identity and another live credential. Only *failures* were
  // rate-limited, and a correct store code is not a failure — so the measured
  // result was five requests, five users, no limit and nothing in the logs.
  const capStamp = Date.now();

  // One known installation first, so there is something to re-enrol after the
  // budget is spent.
  const knownDeviceId = `dev-cap-known-${capStamp}`;
  const knownFirst = await call('POST', '/api/portal/field/enroll', {
    body: {
      storeCode: CAP_STORE_CODE,
      fullName: 'Cap Known Device',
      deviceId: knownDeviceId,
      enrollmentSecret: ENROLLMENT_SECRET || undefined,
    },
  });
  if (knownFirst.status === 200) createdDeviceIds.push(knownDeviceId);

  const attempts: number[] = [];
  for (let i = 0; i < NEW_DEVICE_CAP + 3; i += 1) {
    const deviceId = `dev-cap-${capStamp}-${i}`;
    const result = await call('POST', '/api/portal/field/enroll', {
      body: {
        storeCode: CAP_STORE_CODE,
        fullName: `Cap Probe ${i}`,
        deviceId,
        enrollmentSecret: ENROLLMENT_SECRET || undefined,
      },
    });
    attempts.push(result.status);
    if (result.status === 200) createdDeviceIds.push(deviceId);
  }

  const refused = attempts.filter((status) => status === 429).length;
  const succeeded = attempts.filter((status) => status === 200).length;
  const unexpected = attempts.filter((status) => status !== 200 && status !== 429);

  check('the store eventually stops accepting new installations', refused > 0, {
    refused,
    succeeded,
    cap: NEW_DEVICE_CAP,
  });
  check('a refusal is a 429, not a server error', unexpected.length === 0, unexpected);
  check('a store accepts no more than the configured cap', succeeded <= NEW_DEVICE_CAP, {
    succeeded,
    cap: NEW_DEVICE_CAP,
  });

  // The load-bearing one. The mobile client has no storage layer, so it enrols
  // again on every process start. If re-enrolment were counted, the cap would
  // fire on entirely ordinary use — and a security control that interferes with
  // normal work is one somebody turns off. A known device must never be refused,
  // however much of the budget has been spent.
  const reEnrol = await call('POST', '/api/portal/field/enroll', {
    body: {
      storeCode: CAP_STORE_CODE,
      fullName: 'Cap Known Device',
      deviceId: knownDeviceId,
      enrollmentSecret: ENROLLMENT_SECRET || undefined,
    },
  });
  if (knownFirst.status !== 200) {
    skip(
      'a device that is already enrolled may enrol again after the cap is reached',
      `${CAP_STORE_CODE} had no budget left at the start of this run — restart the API to reset it`,
    );
  } else {
    check(
      'a device that is already enrolled may enrol again after the cap is reached',
      reEnrol.status === 200,
      { knownFirst: knownFirst.status, reEnrol: reEnrol.status, body: reEnrol.body },
    );
  }

  if (!db) {
    skip('the refusal is written to the audit trail', 'DATABASE_URL not set');
  } else {
    const audit = await query(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE action = 'DEVICE_ENROLMENT_LIMIT_REACHED'
          AND payload->>'storeCode' = $1`,
      [CAP_STORE_CODE],
    );
    check('the refusal is written to the audit trail', (audit[0]?.n ?? 0) > 0, audit[0]?.n);
  }

  // -------------------------------------------------------------------------
  // The second factor, when configured
  // -------------------------------------------------------------------------
  if (secretRequired) {
    console.log('\nthe enrolment second factor');
    const wrong = await call('POST', '/api/portal/field/enroll', {
      body: {
        storeCode: STORE_CODE,
        fullName: 'Wrong Secret',
        deviceId: 'dev-wrong-secret',
        enrollmentSecret: 'definitely-not-the-secret',
      },
    });
    if (wrong.status === 429) {
      skip('a wrong enrolment secret is refused with 401', 'enrolment failure window exhausted');
    } else {
      check('a wrong enrolment secret is refused with 401', wrong.status === 401, wrong);
    }

    const noSecret = await call('POST', '/api/portal/field/enroll', {
      body: { storeCode: STORE_CODE, fullName: 'No Secret', deviceId: 'dev-no-secret' },
    });
    if (noSecret.status === 429) {
      skip('a missing enrolment secret is refused with 401', 'enrolment failure window exhausted');
    } else {
      check('a missing enrolment secret is refused with 401', noSecret.status === 401, noSecret);
    }
  }

  // -------------------------------------------------------------------------
  // Clean up what this run created
  // -------------------------------------------------------------------------
  if (!db) {
    skip('the installations this suite created are removed again', 'DATABASE_URL not set');
  } else if (createdDeviceIds.length === 0) {
    skip('the installations this suite created are removed again', 'this run created none');
  } else {
    // Defensive, because the schema is not uniformly forgiving: `device_tokens`,
    // `store_tasks.assigned_user_id` and `audit_logs.actor_id` are all ON DELETE
    // SET NULL, but `task_evidences.submitted_by_id` is ON DELETE RESTRICT — so
    // an installation that submitted evidence cannot be removed at all, and the
    // delete would throw. Failing the whole suite over housekeeping would be the
    // wrong trade, so this reports instead.
    try {
      const removed = await query(
        `DELETE FROM users WHERE mobile_device_id = ANY($1) RETURNING id`,
        [createdDeviceIds],
      );
      check(
        'the installations this suite created are removed again',
        removed.length === createdDeviceIds.length,
        { created: createdDeviceIds.length, removed: removed.length },
      );
    } catch (error) {
      skip(
        'the installations this suite created are removed again',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (db) await db.end();

  console.log(`\n=== ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''} ===\n`);
  if (skipped) {
    console.log(
      '  A skip means the assertion could not run, not that it held. Two controls\n' +
        '  can cause one, and both are per-process state that a restart clears:\n' +
        '\n' +
        '    - enrolment failures are counted per address, so repeated runs in\n' +
        '      quick succession exhaust the budget;\n' +
        '    - new installations are capped per store per window, so the stores\n' +
        '      this suite enrols into run out of budget after a few runs.\n' +
        '\n' +
        '  Restart the API to reset both. To exercise the cap deliberately, start\n' +
        '  it with a small ONETEAM_ENROLLMENT_MAX_NEW_DEVICES and pass the same\n' +
        '  value to this suite so the loop and the API agree on the number.\n',
    );
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(
    `\n\u274C Device credential suite failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
