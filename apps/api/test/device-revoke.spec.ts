/**
 * oneTeam — device revocation suite
 * ============================================================================
 *
 * WHY THIS EXISTS AS A PERMANENT TEST
 * -----------------------------------
 * Phase 3.2 gave a phone an identity that survives a restart. It did not give
 * anyone the ability to take that identity back. The only two paths that
 * existed both needed the phone itself — the device can re-enrol, or the person
 * can be deleted — and deletion is refused with `409 USER_HAS_SUBMISSIONS` for
 * exactly the people who file audits, which is every merchandiser. On iOS the
 * keychain outlives the app, so a phone left in a taxi stayed a working
 * credential, and the next person to hold it carried the previous worker's
 * identity with no way to take it back from the panel.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * --------------------------------------
 * The load-bearing assertion is NOT that the route answers 200. It is that a
 * credential which WORKED before the call does not work after it. So this suite
 * authenticates the device first, and treats a refusal at that point as a
 * failure rather than a skip — if the precondition is broken, every later
 * assertion would pass for the wrong reason and read as a working feature.
 *
 * It also asserts the boundary from three sides, because "who may cut a device
 * off" is the part most easily got wrong quietly:
 *
 *   - a device credential must not reach the panel route at all;
 *   - a merchandiser's panel key must be refused, by role;
 *   - a supervisor's panel key must be accepted — the whole point of the route
 *     is that the person standing in the store does not have to wait for an
 *     administrator.
 *
 * And it asserts the neighbour is left alone: revoking one device must not
 * touch another live device belonging to the same person.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not scope by store, because the route does not either: nothing in
 * this codebase gives a supervisor a set of stores they are responsible for, so
 * a supervisor can cut off any device. That is a deliberate limitation of the
 * current role model, written down in the controller rather than hidden here.
 *
 * It creates the device credential by inserting the row rather than by
 * enrolling a phone. Enrolment is covered by `test:device`. What matters here
 * is that the row is a *working* credential, which the suite proves before it
 * revokes anything. The hash is derived independently with the same SHA-256 the
 * API uses, not taken on trust from a response.
 *
 * Prerequisites: the API must be running against the same DATABASE_URL, and
 * either the panel must still be open (so this suite can mint its own keys) or
 * `ONETEAM_PANEL_KEY` must hold an administrator's key.
 *
 *   npm run api:dev
 *   DATABASE_URL=postgres://... ONETEAM_API_URL=http://localhost:3001 \
 *     npm run test:device-revoke
 */

import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';

const API_BASE = (process.env.ONETEAM_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || '';

/**
 * The service credential the bot carries.
 *
 * Enough to mint a key only while the panel is still open. Once a key exists,
 * `mayUseRoute` refuses this credential on `/api/panel/*` — which is the
 * behaviour `test:panel` asserts, and the reason `ONETEAM_PANEL_KEY` exists
 * below.
 */
const ADMIN_SERVICE_TOKEN = process.env.ONETEAM_TEST_SERVICE_TOKEN || 'oneteam-user:usr-admin-001';

/** An administrator's panel key, for a deployment whose panel is already locked. */
const SUPPLIED_PANEL_KEY = process.env.ONETEAM_PANEL_KEY || '';

const ADMIN_USER = process.env.ONETEAM_TEST_ADMIN_USER || 'usr-admin-001';
const SUPERVISOR_USER = process.env.ONETEAM_TEST_SUPERVISOR_USER || 'usr-super-002';
const MERCH_USER = process.env.ONETEAM_TEST_MERCH_USER || 'usr-merch-003';

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
 * Reported separately from a pass and from a failure. The only thing that skips
 * here is the whole suite when the panel is locked and no key was supplied:
 * there is no way to mint one, and pretending otherwise would either fail
 * spuriously or — far worse — pass without exercising anything.
 */
function skip(name: string, why: string): void {
  skipped += 1;
  console.log(`  \u25CB ${name} — SKIPPED: ${why}`);
}

/** The same digest the API stores. Derived here so the suite does not trust a response. */
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

/**
 * Polls a predicate until it holds or the budget runs out.
 *
 * The audit trail is written through the fire-and-forget path, so the row is
 * not guaranteed to exist the instant the route answers. Waiting a bounded
 * moment is honest; asserting immediately would make the suite flaky, and
 * skipping the assertion would drop the only check that the act was recorded.
 */
async function waitFor<T>(probe: () => Promise<T | null>, budgetMs = 3000): Promise<T | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const found = await probe();
    if (found) return found;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Panel keys this suite minted, so a crash half-way through cannot leave the panel locked. */
const minted: string[] = [];

/** Device credentials this suite inserted. */
const createdDeviceIds: string[] = [];

async function main(): Promise<void> {
  console.log(`\n=== device revocation suite against ${API_BASE} ===`);

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

  // The whole suite is about rows in a table, so a run without a database would
  // be a run that proves nothing. Refused rather than degraded.
  if (!DATABASE_URL) {
    console.log(
      '\n  \u2717 DATABASE_URL is not set.\n' +
        '      This suite creates and revokes a real device credential, so it needs the\n' +
        '      same database the API is using. Set DATABASE_URL and run it again.\n',
    );
    process.exitCode = 1;
    return;
  }

  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();

  const query = async (sql: string, params: unknown[] = []): Promise<any[]> => {
    const result = await db.query(sql, params as any[]);
    return result.rows;
  };

  const liveKeysBefore = Number(
    (await call('GET', '/api/panel/auth-status')).body?.data?.liveKeys ?? 0,
  );

  // -------------------------------------------------------------------------
  // The credential boundary — probed while the panel is still open
  // -------------------------------------------------------------------------
  //
  // WHY THIS IS HERE AND NOT FURTHER DOWN
  // -------------------------------------
  // The first version of this suite asserted this AFTER minting its own keys,
  // and the break harness caught what that was worth: with the panel locked,
  // `mayUseRoute` refuses a device credential for the WRONG reason. It falls
  // through to the "the panel now requires a key" branch, so deleting the
  // `via === 'device'` refusal entirely left this check green — the answer was
  // still 403 `PANEL_KEY_REQUIRED`, just from a different line. A check that
  // passes with the guard removed is not a check.
  //
  // While the panel does not yet require a key the two are distinguishable: the
  // correct code refuses with `PANEL_KEY_REQUIRED`, and code with the device
  // branch deleted lets the credential reach the handler, which answers
  // `SUPERVISOR_REQUIRED` instead. So this runs first, before anything is
  // minted — and is skipped, loudly, on a deployment whose panel was already
  // locked, where the two refusals are identical and the check proves nothing.
  console.log('\nwhich credential may reach the panel');

  const boundaryDeviceId = `dev-boundary-${Date.now().toString(36)}`;
  const boundaryToken = 'otd_' + randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO device_tokens (token_hash, user_id, device_id, label)
     VALUES ($1, $2, $3, $4)`,
    [sha256(boundaryToken), MERCH_USER, boundaryDeviceId, 'device-revoke suite — boundary'],
  );
  createdDeviceIds.push(boundaryDeviceId);

  const anonymous = await call('GET', '/api/panel/devices');
  check('the device list refuses a request with no credential', anonymous.status === 401);

  if (liveKeysBefore === 0) {
    const asDevice = await call('GET', '/api/panel/devices', { token: boundaryToken });
    check('a device credential cannot reach the panel route at all', asDevice.status === 403, {
      status: asDevice.status,
      body: asDevice.body,
    });
    check(
      'and is refused as a panel-route problem, not as a role problem',
      asDevice.body?.error === 'PANEL_KEY_REQUIRED',
      asDevice.body,
    );
  } else {
    skip(
      'a device credential cannot reach the panel route at all',
      `the panel already had ${liveKeysBefore} key(s), so a device credential is also ` +
        'refused by the "panel requires a key" branch — the two refusals cannot be told ' +
        'apart here, and the check would pass either way',
    );
  }

  // -------------------------------------------------------------------------
  // Getting a key to mint with
  // -------------------------------------------------------------------------
  console.log('\npreconditions: a panel key to act with');

  let adminKey = SUPPLIED_PANEL_KEY;
  let suppliedKeyIsOurs = false;

  if (adminKey) {
    const works = await call('GET', '/api/panel/me', { token: adminKey });
    check('the supplied ONETEAM_PANEL_KEY is accepted', works.status === 200, works.status);
    if (works.status !== 200) {
      console.log('      The key was supplied but refused, so nothing below can run.\n');
      await db.end();
      process.exitCode = 1;
      return;
    }
  } else {
    const mintedAdmin = await call('POST', '/api/panel/keys', {
      token: ADMIN_SERVICE_TOKEN,
      body: { userId: ADMIN_USER, label: 'device-revoke suite — admin' },
    });

    if (mintedAdmin.status !== 201) {
      // A locked panel with no key in hand. Reported, not worked around: the
      // alternative is to revoke somebody's key to make a suite pass, which
      // would be a far worse failure than a skip.
      skip(
        'every check below',
        'the panel is already locked and no ONETEAM_PANEL_KEY was supplied, so this ' +
          'suite cannot mint the keys it needs (status ' +
          `${mintedAdmin.status})`,
      );
      console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
      await db.end();
      return;
    }

    adminKey = mintedAdmin.body?.data?.token ?? '';
    if (adminKey) minted.push(adminKey);
    suppliedKeyIsOurs = true;
    check('an administrator can mint a key to run this suite with', adminKey.startsWith('otp_'));
  }

  const supervisorKey = (
    await call('POST', '/api/panel/keys', {
      token: adminKey,
      body: { userId: SUPERVISOR_USER, label: 'device-revoke suite — supervisor' },
    })
  ).body?.data?.token as string;
  if (supervisorKey) minted.push(supervisorKey);
  check('a supervisor key exists to test the role gate with', Boolean(supervisorKey));

  const merchKey = (
    await call('POST', '/api/panel/keys', {
      token: adminKey,
      body: { userId: MERCH_USER, label: 'device-revoke suite — merchandiser' },
    })
  ).body?.data?.token as string;
  if (merchKey) minted.push(merchKey);
  check('a merchandiser key exists to be refused with', Boolean(merchKey));

  // -------------------------------------------------------------------------
  // A real, working device credential
  // -------------------------------------------------------------------------
  console.log('\na device credential that works');

  const stamp = Date.now().toString(36);
  const deviceA = `dev-revoke-a-${stamp}`;
  const deviceB = `dev-revoke-b-${stamp}`;
  const tokenA = 'otd_' + randomBytes(32).toString('base64url');
  const tokenB = 'otd_' + randomBytes(32).toString('base64url');

  for (const [deviceId, token] of [
    [deviceA, tokenA],
    [deviceB, tokenB],
  ] as const) {
    await query(
      `INSERT INTO device_tokens (token_hash, user_id, device_id, label)
       VALUES ($1, $2, $3, $4)`,
      [sha256(token), MERCH_USER, deviceId, 'device-revoke suite'],
    );
    createdDeviceIds.push(deviceId);
  }

  // The precondition the whole suite rests on. If this fails, every "it stopped
  // working" assertion below would pass for the wrong reason.
  const worksBefore = await call('GET', '/api/portal/field/whoami', { token: tokenA });
  check(
    'the device credential authenticates BEFORE anything is revoked',
    worksBefore.status === 200,
    { status: worksBefore.status, body: worksBefore.body },
  );
  check(
    'and it resolves to the merchandiser it was inserted for',
    worksBefore.body?.data?.userId === MERCH_USER ||
      worksBefore.body?.userId === MERCH_USER ||
      worksBefore.body?.data?.user?.id === MERCH_USER,
    worksBefore.body,
  );

  // -------------------------------------------------------------------------
  // Who may do this
  // -------------------------------------------------------------------------
  console.log('\nthe role boundary');

  const asMerch = await call('GET', '/api/panel/devices', { token: merchKey });
  check('a merchandiser panel key is refused by role', asMerch.status === 403, {
    status: asMerch.status,
    body: asMerch.body,
  });
  check(
    'and the refusal names the role that is missing',
    asMerch.body?.error === 'SUPERVISOR_REQUIRED',
    asMerch.body,
  );

  const asSupervisor = await call('GET', '/api/panel/devices', { token: supervisorKey });
  check('a supervisor may read the device list', asSupervisor.status === 200, {
    status: asSupervisor.status,
    body: asSupervisor.body,
  });

  // The role gate on the ACT, not only on the list. A refusal on a read route
  // proves nothing about the write one, and the write one is what takes a
  // credential away.
  //
  // Aimed at `deviceB` deliberately: if the gate is ever removed, this call
  // really does cut that device off, and the blast radius stays visible — the
  // "other device is left alone" check further down goes red as well, which is
  // the honest picture. Aiming it at `deviceA` would instead make every later
  // check fail for one reason and hide which guard was missing.
  const merchRevokes = await call('POST', `/api/panel/devices/${deviceB}/revoke`, {
    token: merchKey,
  });
  check('and a merchandiser cannot cut a device off', merchRevokes.status === 403, {
    status: merchRevokes.status,
    body: merchRevokes.body,
  });
  check(
    'with the same named refusal as the list route',
    merchRevokes.body?.error === 'SUPERVISOR_REQUIRED',
    merchRevokes.body,
  );

  const devices: any[] = asSupervisor.body?.data?.devices ?? [];
  const rowA = devices.find((row) => row.deviceId === deviceA);
  check('the list reports the device this suite created', Boolean(rowA), deviceA);
  check('and reports it as live', rowA?.live === true, rowA);
  check(
    'and does not print the token hash',
    rowA?.tokenHash === undefined,
    Object.keys(rowA ?? {}),
  );

  const asAdmin = await call('GET', '/api/panel/devices', { token: adminKey });
  check('an administrator may read it too', asAdmin.status === 200, asAdmin.status);

  // -------------------------------------------------------------------------
  // The act
  // -------------------------------------------------------------------------
  console.log('\ncutting the device off');

  const revoke = await call('POST', `/api/panel/devices/${deviceA}/revoke`, {
    token: supervisorKey,
  });
  check('a supervisor can cut a device off', revoke.status === 200, {
    status: revoke.status,
    body: revoke.body,
  });
  check('and the answer says how many credentials were cut', revoke.body?.data?.revoked === 1, {
    body: revoke.body,
  });

  // The assertion this suite exists for.
  const worksAfter = await call('GET', '/api/portal/field/whoami', { token: tokenA });
  check('THE DEVICE CREDENTIAL STOPS WORKING', worksAfter.status === 401, {
    status: worksAfter.status,
    body: worksAfter.body,
  });

  const neighbour = await call('GET', '/api/portal/field/whoami', { token: tokenB });
  check("and the person's OTHER device is left alone", neighbour.status === 200, {
    status: neighbour.status,
    body: neighbour.body,
  });

  const revokeAgain = await call('POST', `/api/panel/devices/${deviceA}/revoke`, {
    token: supervisorKey,
  });
  check('revoking it a second time is not reported as success', revokeAgain.status === 404, {
    status: revokeAgain.status,
    body: revokeAgain.body,
  });
  check(
    'and says which of the two things happened',
    revokeAgain.body?.error === 'DEVICE_NOT_FOUND',
    revokeAgain.body,
  );

  const afterList = await call('GET', '/api/panel/devices', { token: supervisorKey });
  const rowAAfter = (afterList.body?.data?.devices ?? []).find(
    (row: any) => row.deviceId === deviceA,
  );
  check('the device is still listed, so the record survives', Boolean(rowAAfter), deviceA);
  check('but it is no longer live', rowAAfter?.live === false, rowAAfter);
  check('and it carries when it was cut off', typeof rowAAfter?.revokedAt === 'string', rowAAfter);

  const audit = await waitFor(async () => {
    const rows = await query(
      `SELECT actor_id, payload FROM audit_logs
        WHERE action = 'DEVICE_CREDENTIAL_REVOKED'
          AND entity_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [deviceA],
    );
    return rows[0] ?? null;
  });
  check('the act is in the audit trail', Boolean(audit), deviceA);
  check(
    'and the audit names the supervisor who did it',
    audit?.actor_id === SUPERVISOR_USER,
    audit,
  );

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------
  console.log('\ncleanup');

  const removedDevices = await query(
    `DELETE FROM device_tokens
      WHERE device_id = ANY($1::text[])
      RETURNING device_id`,
    [createdDeviceIds],
  );
  check(
    'the credentials this suite created are gone',
    removedDevices.length === createdDeviceIds.length,
    { expected: createdDeviceIds.length, removed: removedDevices.length },
  );

  const removedAudit = await query(
    `DELETE FROM audit_logs
      WHERE action = 'DEVICE_CREDENTIAL_REVOKED'
        AND entity_id = ANY($1::text[])
      RETURNING id`,
    [createdDeviceIds],
  );
  check('and so are the audit rows it caused', removedAudit.length > 0, removedAudit.length);

  if (minted.length > 0) {
    const stragglers = await query(
      `UPDATE panel_tokens
          SET revoked_at = now()
        WHERE token_hash = ANY($1::text[])
          AND revoked_at IS NULL
      RETURNING token_hash`,
      [minted.map((token) => sha256(token))],
    );
    check('the keys this suite minted are revoked', stragglers.length === minted.length, {
      minted: minted.length,
      revoked: stragglers.length,
    });
  }

  const liveNow = Number((await call('GET', '/api/panel/auth-status')).body?.data?.liveKeys ?? 0);
  if (suppliedKeyIsOurs || !SUPPLIED_PANEL_KEY) {
    check('the live-key count is back where the suite found it', liveNow === liveKeysBefore, {
      before: liveKeysBefore,
      after: liveNow,
    });
  } else {
    skip(
      'the live-key count is back where the suite found it',
      'the key in use was supplied by the operator and is deliberately left alone',
    );
  }

  await db.end();

  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error('\nThe suite could not finish:', error);
  // Cleanup even on a crash. A key left behind locks the panel for every other
  // suite, and the next person to run one would have no idea why.
  if (DATABASE_URL && minted.length > 0) {
    try {
      const db = new Client({ connectionString: DATABASE_URL });
      await db.connect();
      await db.query(
        `UPDATE panel_tokens SET revoked_at = now()
          WHERE token_hash = ANY($1::text[]) AND revoked_at IS NULL`,
        [minted.map((token) => sha256(token))],
      );
      await db.end();
      console.error(`(revoked ${minted.length} key(s) minted by this run)`);
    } catch (cleanupError) {
      console.error('Could not clean up the minted keys:', cleanupError);
    }
  }
  process.exitCode = 1;
});
