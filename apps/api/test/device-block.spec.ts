/**
 * oneTeam — device block suite
 * ============================================================================
 *
 * WHY THIS EXISTS AS A PERMANENT TEST
 * -----------------------------------
 * `test:device-revoke` proves a supervisor can take a credential away: the row
 * stops authenticating. It does NOT prove the revocation LASTS. The mobile
 * client holds no token across restarts and re-enrols on every process start,
 * so a revoke that only cleared the token would be undone the next time the app
 * opened — the phone a supervisor cut off would hand itself a fresh credential
 * at `POST /api/portal/field/enroll` seconds later. On iOS the keychain
 * outlives the app, so the `device_id` outlives the person, and that re-enrol
 * would carry the previous worker's identity.
 *
 * The block is what makes "cut this phone off" mean the phone STAYS off. This
 * suite proves the three things that have to be true for that to hold:
 *
 *   - revoking a device sets an active block, as a side effect of the one
 *     action the supervisor takes;
 *   - while the block is active, a re-enrolment of that device is refused with
 *     `403 DEVICE_BLOCKED` — the credential cannot be re-minted from the field;
 *   - only an administrator may lift the block (`requireAdmin`), and once lifted
 *     the device is no longer barred.
 *
 * WHAT IT PROVES AND HOW
 * ----------------------
 * The enrol-refused assertion is run as a REAL HTTP enrolment, because that
 * path is side-effect-free while the block is active: the guard sits before the
 * bind, so no user is created and no store work is claimed — only an audit row
 * noting a barred device tried.
 *
 * The "no longer blocked after an admin lifts it" assertion is proven by the
 * exact predicate the enrol guard reads — the `device_blocks` row is cleared
 * and the device list reports `blocked:false` — rather than by running a second
 * enrolment. A successful enrolment binds a user and CLAIMS the store's open
 * tasks (see `field.service.ts#claimStoreTasks`), which would mutate real
 * assignment state. The full happy-path enrol is `test:device`'s job; here it is
 * enough, and cleaner, to prove the bar the guard checks is gone.
 *
 * The role boundary is asserted from below: a merchandiser AND a supervisor are
 * both refused the unblock with `ADMIN_REQUIRED`, because lifting a block is an
 * access decision in the same category as minting a key.
 *
 * Prerequisites: the API must be running against the same DATABASE_URL, and
 * either the panel must still be open (so this suite can mint its own keys) or
 * `ONETEAM_PANEL_KEY` must hold an administrator's key. An active store must
 * exist for the enrol-refused assertion; if none does, that one check skips.
 *
 *   npm run api:dev
 *   DATABASE_URL=postgres://... ONETEAM_API_URL=http://localhost:3001 \
 *     npm run test:device-block
 */

import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';

const API_BASE = (process.env.ONETEAM_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || '';

/**
 * The service credential the bot carries. Enough to mint a key only while the
 * panel is still open; once a key exists `mayUseRoute` refuses it on
 * `/api/panel/*`, which is why `ONETEAM_PANEL_KEY` exists below.
 */
const ADMIN_SERVICE_TOKEN = process.env.ONETEAM_TEST_SERVICE_TOKEN || 'oneteam-user:usr-admin-001';

/** An administrator's panel key, for a deployment whose panel is already locked. */
const SUPPLIED_PANEL_KEY = process.env.ONETEAM_PANEL_KEY || '';

/**
 * The enrolment secret, if this deployment sets one. The block guard sits AFTER
 * the secret check in `POST /api/portal/field/enroll`, so without the right
 * secret the enrol-refused assertion never reaches the guard it means to test —
 * it is skipped loudly in that case rather than passing for the wrong reason.
 */
const ENROLLMENT_SECRET = process.env.ONETEAM_ENROLLMENT_SECRET || '';

const ADMIN_USER = process.env.ONETEAM_TEST_ADMIN_USER || 'usr-admin-001';
const SUPERVISOR_USER = process.env.ONETEAM_TEST_SUPERVISOR_USER || 'usr-super-002';
const MERCH_USER = process.env.ONETEAM_TEST_MERCH_USER || 'usr-merch-003';

let pass = 0;
let fail = 0;
let skipped = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}`);
    if (detail !== undefined) console.log(`      got: ${JSON.stringify(detail)}`);
  }
}

/**
 * A check that could not run. Reported separately from a pass and a failure.
 * Things that skip here: the whole suite when the panel is locked and no key
 * was supplied; the enrol-refused assertion when no active store exists or the
 * enrolment secret is unknown to this run.
 */
function skip(name: string, why: string): void {
  skipped += 1;
  console.log(`  ○ ${name} — SKIPPED: ${why}`);
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
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/**
 * Polls a predicate until it holds or the budget runs out. The audit trail is
 * written through the fire-and-forget path, so a row is not guaranteed to exist
 * the instant the route answers. Waiting a bounded moment is honest; asserting
 * immediately would make the suite flaky.
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
  console.log(`\n=== device block suite against ${API_BASE} ===`);

  try {
    const health = await call('GET', '/api/health');
    check('the API answers /api/health', health.status === 200, health.status);
  } catch (error) {
    console.log(`\n  ✗ the API is not reachable at ${API_BASE}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
    console.log('\n  Start it with `npm run api:dev` and try again.\n');
    process.exitCode = 1;
    return;
  }

  // The whole suite is about rows in a table, so a run without a database would
  // prove nothing. Refused rather than degraded.
  if (!DATABASE_URL) {
    console.log(
      '\n  ✗ DATABASE_URL is not set.\n' +
        '      This suite blocks and unblocks a real device, so it needs the same\n' +
        '      database the API is using. Set DATABASE_URL and run it again.\n',
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
      body: { userId: ADMIN_USER, label: 'device-block suite — admin' },
    });

    if (mintedAdmin.status !== 201) {
      // A locked panel with no key in hand. Reported, not worked around.
      skip(
        'every check below',
        'the panel is already locked and no ONETEAM_PANEL_KEY was supplied, so this ' +
          `suite cannot mint the keys it needs (status ${mintedAdmin.status})`,
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
      body: { userId: SUPERVISOR_USER, label: 'device-block suite — supervisor' },
    })
  ).body?.data?.token as string;
  if (supervisorKey) minted.push(supervisorKey);
  check('a supervisor key exists to cut the device off with', Boolean(supervisorKey));

  const merchKey = (
    await call('POST', '/api/panel/keys', {
      token: adminKey,
      body: { userId: MERCH_USER, label: 'device-block suite — merchandiser' },
    })
  ).body?.data?.token as string;
  if (merchKey) minted.push(merchKey);
  check('a merchandiser key exists to be refused with', Boolean(merchKey));

  // An active store the refused re-enrolment can aim at. The guard this suite
  // tests sits AFTER the store lookup, so without a real active store the enrol
  // would stop at STORE_NOT_FOUND / STORE_INACTIVE and never reach the block —
  // hence we query one rather than insert one (stores.region_id is a NOT NULL FK
  // to regions, so an inserted store would need a region to hang off anyway).
  const activeStore = (
    await query(`SELECT store_code FROM stores WHERE is_active = true LIMIT 1`)
  )[0]?.store_code as string | undefined;

  // -------------------------------------------------------------------------
  // A real, working device credential
  // -------------------------------------------------------------------------
  console.log('\na device credential that works');

  const stamp = Date.now().toString(36);
  const deviceA = `dev-block-a-${stamp}`;
  const tokenA = 'otd_' + randomBytes(32).toString('base64url');

  await query(
    `INSERT INTO device_tokens (token_hash, user_id, device_id, label)
     VALUES ($1, $2, $3, $4)`,
    [sha256(tokenA), MERCH_USER, deviceA, 'device-block suite'],
  );
  createdDeviceIds.push(deviceA);

  // The precondition the "it stopped working" and block assertions rest on.
  const worksBefore = await call('GET', '/api/portal/field/whoami', { token: tokenA });
  check(
    'the device credential authenticates BEFORE anything is revoked',
    worksBefore.status === 200,
    { status: worksBefore.status, body: worksBefore.body },
  );

  // -------------------------------------------------------------------------
  // Revoking sets the block, as a side effect of the one act the supervisor takes
  // -------------------------------------------------------------------------
  console.log('\ncutting the device off sets a block');

  const revoke = await call('POST', `/api/panel/devices/${deviceA}/revoke`, {
    token: supervisorKey,
  });
  check('a supervisor can cut the device off', revoke.status === 200, {
    status: revoke.status,
    body: revoke.body,
  });
  check('and the credential is reported cut', revoke.body?.data?.revoked === 1, revoke.body);
  // The new behaviour: the same call that revokes also raises the block, so a
  // supervisor does not have to remember a second step for the cut to last.
  check(
    'and the SAME call reports the device blocked',
    revoke.body?.data?.blocked === true,
    revoke.body,
  );

  const blockedList = await call('GET', '/api/panel/devices', { token: supervisorKey });
  const rowA = (blockedList.body?.data?.devices ?? []).find((row: any) => row.deviceId === deviceA);
  check('the device list still carries the record', Boolean(rowA), deviceA);
  check('and the list reports it blocked', rowA?.blocked === true, rowA);
  check('and no longer live', rowA?.live === false, rowA);

  // The block row the enrol guard reads, asserted directly: active, and
  // attributed to the supervisor who revoked.
  const activeBlock = (
    await query(
      `SELECT blocked_by, cleared_at FROM device_blocks
        WHERE device_id = $1 AND cleared_at IS NULL
        ORDER BY blocked_at DESC LIMIT 1`,
      [deviceA],
    )
  )[0];
  check('an active device_blocks row exists', Boolean(activeBlock), deviceA);
  check(
    'and it names the supervisor who set it',
    activeBlock?.blocked_by === SUPERVISOR_USER,
    activeBlock,
  );

  // -------------------------------------------------------------------------
  // The assertion this feature exists for: a blocked device cannot re-enrol
  // -------------------------------------------------------------------------
  //
  // This is a REAL enrolment, because while the block is active the path is
  // side-effect-free: the guard sits before the bind, so no user is created and
  // no store work is claimed — only an audit row noting a barred device tried.
  console.log('\na blocked device cannot re-enrol');

  if (!activeStore) {
    skip(
      'a blocked device is refused at enrolment',
      'no active store exists to aim the enrolment at, and this suite will not insert ' +
        'one (stores.region_id is a NOT NULL FK), so the guard cannot be reached here',
    );
  } else {
    const reenrol = await call('POST', '/api/portal/field/enroll', {
      body: {
        storeCode: activeStore,
        fullName: 'Device Block Suite',
        deviceId: deviceA,
        ...(ENROLLMENT_SECRET ? { enrollmentSecret: ENROLLMENT_SECRET } : {}),
      },
    });

    if (reenrol.body?.error === 'ENROLLMENT_SECRET_REQUIRED') {
      // The guard sits after the secret check, so without the right secret the
      // enrol never reaches it. Skipped rather than read as a block.
      skip(
        'a blocked device is refused at enrolment',
        'this deployment requires an enrolment secret that was not supplied, so the ' +
          'enrolment stops before the block guard (set ONETEAM_ENROLLMENT_SECRET to run it)',
      );
    } else {
      check('a blocked device is refused at enrolment', reenrol.status === 403, {
        status: reenrol.status,
        body: reenrol.body,
      });
      check(
        'and the refusal names the block, not a store or secret problem',
        reenrol.body?.error === 'DEVICE_BLOCKED',
        reenrol.body,
      );

      const refusalAudit = await waitFor(async () => {
        const rows = await query(
          `SELECT entity_id FROM audit_logs
            WHERE action = 'DEVICE_ENROLMENT_BLOCKED' AND entity_id = $1
            ORDER BY created_at DESC LIMIT 1`,
          [deviceA],
        );
        return rows[0] ?? null;
      });
      check('and the refused attempt is in the audit trail', Boolean(refusalAudit), deviceA);
    }
  }

  // -------------------------------------------------------------------------
  // Who may lift the block
  // -------------------------------------------------------------------------
  //
  // Lifting a block re-opens a credential path from the field, so it is an
  // access decision in the same category as minting a key: administrator only.
  // `requireAdmin` runs BEFORE `clearDeviceBlock`, so a refused attempt must
  // leave the block standing — which the DB probe after these two confirms.
  console.log('\nonly an administrator may lift the block');

  const merchUnblock = await call('POST', `/api/panel/devices/${deviceA}/unblock`, {
    token: merchKey,
  });
  check('a merchandiser cannot lift a block', merchUnblock.status === 403, {
    status: merchUnblock.status,
    body: merchUnblock.body,
  });
  check(
    'and is told an administrator is required',
    merchUnblock.body?.error === 'ADMIN_REQUIRED',
    merchUnblock.body,
  );

  const supervisorUnblock = await call('POST', `/api/panel/devices/${deviceA}/unblock`, {
    token: supervisorKey,
  });
  check('a supervisor cannot lift a block either', supervisorUnblock.status === 403, {
    status: supervisorUnblock.status,
    body: supervisorUnblock.body,
  });
  check(
    'and gets the same named refusal',
    supervisorUnblock.body?.error === 'ADMIN_REQUIRED',
    supervisorUnblock.body,
  );

  const stillBlocked = (
    await query(`SELECT 1 FROM device_blocks WHERE device_id = $1 AND cleared_at IS NULL LIMIT 1`, [
      deviceA,
    ])
  ).length;
  check('a refused unblock leaves the block standing', stillBlocked === 1, { stillBlocked });

  // -------------------------------------------------------------------------
  // An administrator lifts it, and the device is no longer barred
  // -------------------------------------------------------------------------
  //
  // "No longer barred" is proven by the exact predicate the enrol guard reads —
  // the device_blocks row is cleared and the list reports blocked:false — NOT by
  // running a second enrolment. A successful enrol binds a user and claims the
  // store's open tasks (field.service.ts#claimStoreTasks); the happy-path enrol
  // is test:device's job. Here it is enough, and cleaner, to show the bar is gone.
  console.log('\nan administrator lifts the block');

  const unblock = await call('POST', `/api/panel/devices/${deviceA}/unblock`, { token: adminKey });
  check('an administrator can lift the block', unblock.status === 200, {
    status: unblock.status,
    body: unblock.body,
  });
  check('and the answer says a block was cleared', unblock.body?.data?.cleared === 1, unblock.body);

  const unblockAgain = await call('POST', `/api/panel/devices/${deviceA}/unblock`, {
    token: adminKey,
  });
  check('lifting it a second time is not reported as success', unblockAgain.status === 404, {
    status: unblockAgain.status,
    body: unblockAgain.body,
  });
  check(
    'and says there was no active block to lift',
    unblockAgain.body?.error === 'DEVICE_NOT_BLOCKED',
    unblockAgain.body,
  );

  // The predicate the enrol guard reads: no active block, cleared by the admin.
  const clearedBlock = (
    await query(
      `SELECT cleared_at, cleared_by FROM device_blocks
        WHERE device_id = $1 ORDER BY blocked_at DESC LIMIT 1`,
      [deviceA],
    )
  )[0];
  check('the block row is now cleared', clearedBlock?.cleared_at !== null, clearedBlock);
  check(
    'and names the administrator who lifted it',
    clearedBlock?.cleared_by === ADMIN_USER,
    clearedBlock,
  );

  const clearedList = await call('GET', '/api/panel/devices', { token: supervisorKey });
  const rowACleared = (clearedList.body?.data?.devices ?? []).find(
    (row: any) => row.deviceId === deviceA,
  );
  check(
    'and the device list reports it no longer blocked',
    rowACleared?.blocked === false,
    rowACleared,
  );

  const clearAudit = await waitFor(async () => {
    const rows = await query(
      `SELECT actor_id FROM audit_logs
        WHERE action = 'DEVICE_BLOCK_CLEARED' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [deviceA],
    );
    return rows[0] ?? null;
  });
  check('the lift is in the audit trail', Boolean(clearAudit), deviceA);
  check('and names the administrator who did it', clearAudit?.actor_id === ADMIN_USER, clearAudit);

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------
  console.log('\ncleanup');

  const removedDevices = await query(
    `DELETE FROM device_tokens WHERE device_id = ANY($1::text[]) RETURNING device_id`,
    [createdDeviceIds],
  );
  check(
    'the credentials this suite created are gone',
    removedDevices.length === createdDeviceIds.length,
    { expected: createdDeviceIds.length, removed: removedDevices.length },
  );

  const removedBlocks = await query(
    `DELETE FROM device_blocks WHERE device_id = ANY($1::text[]) RETURNING device_id`,
    [createdDeviceIds],
  );
  check('and the block rows it created are gone', removedBlocks.length > 0, removedBlocks.length);

  await query(
    `DELETE FROM audit_logs
      WHERE action = ANY($1::text[]) AND entity_id = ANY($2::text[])`,
    [
      ['DEVICE_CREDENTIAL_REVOKED', 'DEVICE_BLOCK_CLEARED', 'DEVICE_ENROLMENT_BLOCKED'],
      createdDeviceIds,
    ],
  );

  if (minted.length > 0) {
    const stragglers = await query(
      `UPDATE panel_tokens SET revoked_at = now()
        WHERE token_hash = ANY($1::text[]) AND revoked_at IS NULL
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
