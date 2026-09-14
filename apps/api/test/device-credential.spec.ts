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

const API_BASE = (process.env.ONETEAM_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || '';
const STORE_CODE = process.env.ONETEAM_TEST_STORE_CODE || 'BRAVO_YASAMAL_01';
const SERVICE_TOKEN = process.env.ONETEAM_TEST_SERVICE_TOKEN || 'oneteam-user:usr-merch-003';

/** The enrolment second factor, when the API under test requires one. */
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
    throw new Error(
      `The API at ${API_BASE} is not answering (${
        error instanceof Error ? error.message : String(error)
      }).\n       Start it with: npm run api:dev`,
    );
  }

  // Does this deployment require the second factor? Asked rather than assumed,
  // so the suite works against a pilot deployment and a hardened one.
  const probe = await call('POST', '/api/portal/field/enroll', {
    body: { storeCode: STORE_CODE, fullName: 'Probe', deviceId: 'dev-probe-' + Date.now() },
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

  if (db) await db.end();

  console.log(`\n=== ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''} ===\n`);
  if (skipped) {
    console.log(
      '  A skip means the assertion could not run, not that it held. The enrolment\n' +
        '  rate limit counts failures per address, so repeated runs in quick\n' +
        '  succession exhaust the budget — restart the API or wait out the window.\n',
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
