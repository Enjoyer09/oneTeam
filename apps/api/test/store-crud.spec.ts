/**
 * oneTeam — store CRUD suite
 * ============================================================================
 *
 * WHY THIS EXISTS AS A PERMANENT TEST
 * -----------------------------------
 * Stores stopped being seed constants and became rows a supervisor creates,
 * edits and deletes from the panel. That changes what "it worked" means in a
 * way that is easy to get wrong:
 *
 *   The API's read path is an in-memory array. A store can be pushed into that
 *   array, returned to the browser with a 201, rendered in the list — and never
 *   reach PostgreSQL at all. It looks correct until the next deploy, and then
 *   it is gone. This project has already paid for that exact shape of bug more
 *   than once, which is why the store write path awaits its insert instead of
 *   firing and forgetting.
 *
 * So the load-bearing assertion is not "the API answered 201". It is:
 *
 *   THE ROW IS IN POSTGRESQL, READ BACK WITH A SEPARATE CONNECTION,
 *   BEFORE THE CREATE CALL RETURNS.
 *
 * Everything else here guards the edges around that: a duplicate code must be
 * refused rather than silently accepted, a store with field work against it
 * must not be deletable, and the geofence coordinates must not accept a typo.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * --------------------------------------
 * It runs over HTTP against a running API, because the write ordering being
 * tested lives in the API process and an in-process test would not exercise it.
 *
 * IT NEEDS A PANEL CREDENTIAL, AND SAYS SO RATHER THAN FAILING.
 * Once any panel key exists the service credential is refused on
 * `/api/portal/*` — by design, and the panel-auth suite proves it. This suite
 * therefore takes `ONETEAM_TEST_PANEL_KEY` when the panel is locked, falls back
 * to the service credential when it is still open, and skips with the command
 * to fix it when neither is accepted.
 *
 * THIS SUITE CLEANS UP AFTER ITSELF.
 * Every store it creates is deleted, and the last check asserts the store count
 * is back where it started. A leaked store would show up in the panel's list
 * and in `test:replica`'s counts, so a failure to clean up must fail the suite
 * rather than quietly pollute the next run.
 *
 * Prerequisites: the API must be running, and DATABASE_URL must point at the
 * same database it is using.
 *
 *   npm run api:dev
 *   DATABASE_URL=postgres://... ONETEAM_API_URL=http://localhost:3001 \
 *     ONETEAM_TEST_PANEL_KEY=otp_... npm run test:stores
 */

import { Client } from 'pg';

const API_BASE = (process.env.ONETEAM_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || '';

/** A panel login key, when the panel is locked. */
const PANEL_KEY = process.env.ONETEAM_TEST_PANEL_KEY || '';
/** The service credential, usable only while the panel has no keys at all. */
const ADMIN_TOKEN = process.env.ONETEAM_TEST_ADMIN_TOKEN || 'oneteam-user:usr-admin-001';
/** A merchandiser — the role that must not be able to change master data. */
const MERCH_TOKEN = process.env.ONETEAM_TEST_MERCH_TOKEN || 'oneteam-user:usr-merch-003';

/** A seeded store that already has tasks, for the delete-refusal check. */
const STORE_WITH_TASKS = process.env.ONETEAM_TEST_BUSY_STORE || 'str-bravo-yasamal';

/** Unique per run, so two runs against one database do not collide. */
const RUN = Date.now().toString(36).toUpperCase();

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

/** A store body that should be accepted, with the code overridable. */
function storeBody(overrides: Record<string, unknown> = {}) {
  return {
    store_code: `TEST_STORE_${RUN}`,
    name: 'Test Market — Suite',
    address: 'Test ünvanı 1, Bakı',
    city: 'Bakı',
    chain_name: 'TestChain',
    store_format: 'supermarket',
    // Fountain Square, Baku — inside the plausible-bounds guard.
    latitude: 40.3724,
    longitude: 49.8372,
    ...overrides,
  };
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // Which credential are we?
  // ---------------------------------------------------------------------------
  const candidates: Array<{ label: string; token: string }> = [];
  if (PANEL_KEY) candidates.push({ label: 'the panel key', token: PANEL_KEY });
  candidates.push({ label: 'the service credential', token: ADMIN_TOKEN });

  let token = '';
  let usingLabel = '';

  for (const candidate of candidates) {
    const probe = await call('GET', '/api/portal/stores', { token: candidate.token });
    if (probe.status === 200) {
      token = candidate.token;
      usingLabel = candidate.label;
      break;
    }
  }

  if (!token) {
    skip(
      'every store check',
      'no accepted credential. The panel has keys, so the service credential is refused by design. ' +
        'Re-run with ONETEAM_TEST_PANEL_KEY=otp_... (mint one from the panel, or with the bootstrap key).',
    );
    console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
    return;
  }

  console.log(`  · authenticating with ${usingLabel}`);

  const db = DATABASE_URL ? new Client({ connectionString: DATABASE_URL }) : null;
  if (db) await db.connect();

  /** Reads the row straight from PostgreSQL, bypassing the API entirely. */
  const rowInDatabase = async (code: string): Promise<any | null> => {
    if (!db) return null;
    const result = await db.query('SELECT * FROM stores WHERE store_code = $1', [code]);
    return result.rows[0] ?? null;
  };

  const storeCount = async (): Promise<number | null> => {
    if (!db) return null;
    const result = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM stores');
    return Number(result.rows[0]?.count ?? -1);
  };

  const code = `TEST_STORE_${RUN}`;
  const createdIds: string[] = [];

  const countBefore = await storeCount();

  /**
   * A store that really does have tasks.
   *
   * Discovered rather than hardcoded, because the point of the delete-refusal
   * check is the RESTRICT constraint, and asserting against a store id that
   * happens to have no tasks in this particular database would turn a real
   * behaviour into a failure — or worse, pass for the wrong reason.
   */
  let busyStoreId = STORE_WITH_TASKS;
  if (db) {
    const busy = await db.query<{ store_id: string }>(
      'SELECT store_id FROM store_tasks GROUP BY store_id ORDER BY count(*) DESC LIMIT 1',
    );
    if (busy.rows[0]?.store_id) busyStoreId = busy.rows[0].store_id;
  }

  try {
    // -------------------------------------------------------------------------
    console.log('\ncreate');
    // -------------------------------------------------------------------------

    const created = await call('POST', '/api/portal/stores', {
      token,
      body: storeBody(),
    });

    check('POST /api/portal/stores answers 201', created.status === 201, created.body);
    const storeId: string | undefined = created.body?.data?.id;
    check('and returns the new store with an id', typeof storeId === 'string', created.body);
    check(
      'and echoes the code it stored',
      created.body?.data?.store_code === code,
      created.body?.data?.store_code,
    );
    check('and the store starts active', created.body?.data?.is_active === true);

    if (storeId) createdIds.push(storeId);

    // THE LOAD-BEARING ASSERTION. Read back with a separate connection, not
    // through the API: a store that exists only in the API's memory would pass
    // every check above and fail this one.
    if (db) {
      const row = await rowInDatabase(code);
      check(
        'THE ROW IS IN POSTGRESQL BEFORE THE CALL RETURNS',
        row !== null,
        'no row with that store_code — the API answered 201 for a store it never stored',
      );
      check(
        'and the stored coordinates are the ones submitted',
        row !== null &&
          Math.abs(Number(row.latitude) - 40.3724) < 1e-9 &&
          Math.abs(Number(row.longitude) - 49.8372) < 1e-9,
        row && { latitude: row.latitude, longitude: row.longitude },
      );
      check(
        'and it landed in the single seeded region',
        row !== null && typeof row.region_id === 'string' && row.region_id.length > 0,
        row?.region_id,
      );
    } else {
      skip('the read-back-from-PostgreSQL checks', 'DATABASE_URL is not set');
    }

    // -------------------------------------------------------------------------
    console.log('\nappears in the list');
    // -------------------------------------------------------------------------

    const list = await call('GET', '/api/portal/stores', { token });
    check('GET /api/portal/stores answers 200', list.status === 200, list.body);
    check(
      'and the new store is in it',
      Array.isArray(list.body?.data) && list.body.data.some((s: any) => s.id === storeId),
      list.body?.data?.length,
    );

    // -------------------------------------------------------------------------
    console.log('\nduplicate code is refused');
    // -------------------------------------------------------------------------

    const duplicate = await call('POST', '/api/portal/stores', { token, body: storeBody() });
    check(
      'the same code a second time is refused with 409',
      duplicate.status === 409,
      duplicate.body,
    );
    check(
      'and the refusal names the code',
      duplicate.body?.error === 'STORE_CODE_TAKEN',
      duplicate.body,
    );

    const lowercase = await call('POST', '/api/portal/stores', {
      token,
      body: storeBody({ store_code: code.toLowerCase() }),
    });
    check(
      'and a lower-case spelling of it is refused too',
      lowercase.status === 409,
      lowercase.body,
    );

    // A refused duplicate must not have created anything. Two rows sharing a
    // code is impossible under the constraint, but a second row under a
    // *different* code would show the normalization was skipped.
    if (db) {
      const rows = await db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM stores WHERE upper(store_code) = $1',
        [code],
      );
      check('and exactly one row carries that code', Number(rows.rows[0]?.count) === 1);
    }

    // -------------------------------------------------------------------------
    console.log('\nvalidation');
    // -------------------------------------------------------------------------

    const noName = await call('POST', '/api/portal/stores', {
      token,
      body: storeBody({ store_code: `TEST_NONAME_${RUN}`, name: '' }),
    });
    check('a store with no name is refused with 400', noName.status === 400, noName.body);

    const spacedCode = await call('POST', '/api/portal/stores', {
      token,
      body: storeBody({ store_code: 'TEST SPACE CODE' }),
    });
    check(
      'a code containing a space is refused with 400',
      spacedCode.status === 400,
      spacedCode.body,
    );

    const missingPair = await call('POST', '/api/portal/stores', {
      token,
      body: storeBody({ store_code: `TEST_ONELAT_${RUN}`, longitude: undefined }),
    });
    check(
      'coordinates sent without their pair are refused with 400',
      missingPair.status === 400,
      missingPair.body,
    );

    // The typo guard: 4.037 instead of 40.37 is a valid coordinate four
    // thousand kilometres away, and the geofence would refuse every photo from
    // that store with nothing in the panel to explain why.
    const typo = await call('POST', '/api/portal/stores', {
      token,
      body: storeBody({ store_code: `TEST_TYPO_${RUN}`, latitude: 4.03724 }),
    });
    check(
      'a coordinate outside the pilot region is refused with 400',
      typo.status === 400,
      typo.body,
    );
    check(
      'and the message points at the decimal point',
      typeof typo.body?.message === 'string' && typo.body.message.includes('Onluq nöqtə'),
      typo.body?.message,
    );

    const badFormat = await call('POST', '/api/portal/stores', {
      token,
      body: storeBody({ store_code: `TEST_FORMAT_${RUN}`, store_format: 'bazaar' }),
    });
    check('an unknown store format is refused with 400', badFormat.status === 400, badFormat.body);

    // Nothing above may have created a row.
    if (db) {
      const strays = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM stores WHERE store_code LIKE 'TEST\\_%' AND store_code <> $1",
        [code],
      );
      check(
        'and none of the refused requests created a row',
        Number(strays.rows[0]?.count) === 0,
        strays.rows[0]?.count,
      );
    }

    // -------------------------------------------------------------------------
    console.log('\nedit');
    // -------------------------------------------------------------------------

    const renamed = await call('PATCH', `/api/portal/stores/${storeId}`, {
      token,
      body: { name: 'Test Market — Yenilənmiş', city: 'Sumqayıt' },
    });
    check('PATCH answers 200', renamed.status === 200, renamed.body);
    check(
      'and the name is the new one',
      renamed.body?.data?.name === 'Test Market — Yenilənmiş',
      renamed.body?.data?.name,
    );
    check(
      'and the city followed',
      renamed.body?.data?.city === 'Sumqayıt',
      renamed.body?.data?.city,
    );
    check(
      'and a field the request did not mention was left alone',
      renamed.body?.data?.store_code === code,
      renamed.body?.data?.store_code,
    );

    if (db) {
      const row = await rowInDatabase(code);
      check('THE EDIT IS IN POSTGRESQL TOO', row?.name === 'Test Market — Yenilənmiş', row?.name);
    }

    const deactivated = await call('PATCH', `/api/portal/stores/${storeId}`, {
      token,
      body: { is_active: false },
    });
    check(
      'and a store can be deactivated',
      deactivated.body?.data?.is_active === false,
      deactivated.body,
    );

    // Reactivate: leaving a deactivated store behind would make the panel's
    // store list and `test:replica`'s counts disagree with the seed.
    await call('PATCH', `/api/portal/stores/${storeId}`, { token, body: { is_active: true } });

    const emptyPatch = await call('PATCH', `/api/portal/stores/${storeId}`, { token, body: {} });
    check(
      'a PATCH with nothing in it is refused with 400',
      emptyPatch.status === 400,
      emptyPatch.body,
    );

    const unknownId = await call('PATCH', '/api/portal/stores/str-does-not-exist', {
      token,
      body: { name: 'Heç nə' },
    });
    check('a PATCH for an unknown id answers 404', unknownId.status === 404, unknownId.body);
    check(
      'and says the store was not found',
      unknownId.body?.error === 'STORE_NOT_FOUND',
      unknownId.body,
    );

    // -------------------------------------------------------------------------
    console.log('\ndelete');
    // -------------------------------------------------------------------------

    // A store with field work against it must not be removable — that is what
    // `store_tasks.store_id ON DELETE RESTRICT` is for, and the API turns it
    // into an explanation rather than a foreign-key error.
    const busy = await call('DELETE', `/api/portal/stores/${busyStoreId}`, { token });
    check('deleting a store that has tasks is refused with 409', busy.status === 409, busy.body);
    check('and the refusal names the reason', busy.body?.error === 'STORE_HAS_TASKS', busy.body);
    check(
      'and it says how many tasks',
      typeof busy.body?.tasks === 'number' && busy.body.tasks > 0,
      busy.body?.tasks,
    );

    const stillThere = await call('GET', '/api/portal/stores', { token });
    check(
      'and the busy store is still in the list',
      stillThere.body?.data?.some((s: any) => s.id === busyStoreId),
    );

    const removed = await call('DELETE', `/api/portal/stores/${storeId}`, { token });
    check('deleting the store we created answers 200', removed.status === 200, removed.body);

    const afterDelete = await call('GET', '/api/portal/stores', { token });
    check(
      'and it is gone from the list',
      !afterDelete.body?.data?.some((s: any) => s.id === storeId),
    );

    if (db) {
      const row = await rowInDatabase(code);
      check('AND IT IS GONE FROM POSTGRESQL', row === null, row);
    }

    const unknownDelete = await call('DELETE', '/api/portal/stores/str-does-not-exist', { token });
    check('deleting an unknown id answers 404', unknownDelete.status === 404, unknownDelete.body);

    createdIds.length = 0;

    // -------------------------------------------------------------------------
    console.log('\nrole boundary');
    // -------------------------------------------------------------------------

    // Only meaningful while the panel is open: the service credential is the
    // only way to stand in for a merchandiser, and it is refused on these
    // routes once a key exists.
    const probe = await call('GET', '/api/portal/stores', { token: MERCH_TOKEN });
    if (probe.status === 200) {
      const merchCreate = await call('POST', '/api/portal/stores', {
        token: MERCH_TOKEN,
        body: storeBody({ store_code: `TEST_MERCH_${RUN}` }),
      });
      check('a merchandiser may not create a store', merchCreate.status === 403, merchCreate.body);
      check(
        'and the refusal names the role rule',
        merchCreate.body?.error === 'STORE_EDIT_FORBIDDEN',
        merchCreate.body,
      );

      const merchDelete = await call('DELETE', `/api/portal/stores/${busyStoreId}`, {
        token: MERCH_TOKEN,
      });
      check('and may not delete one either', merchDelete.status === 403, merchDelete.body);
    } else {
      skip(
        'the role boundary checks',
        'the panel is locked, so the merchandiser service credential is refused on these routes — ' +
          'this is the expected state in production and the panel-auth suite covers it',
      );
    }

    // -------------------------------------------------------------------------
    console.log('\nno credential');
    // -------------------------------------------------------------------------

    const anonymous = await call('POST', '/api/portal/stores', {
      body: storeBody({ store_code: `TEST_ANON_${RUN}` }),
    });
    check('a create with no credential is refused', anonymous.status === 401, anonymous.body);
  } finally {
    // Clean up whatever the run left behind, even if a check threw.
    for (const id of createdIds) {
      await call('DELETE', `/api/portal/stores/${id}`, { token });
    }

    if (db) {
      const countAfter = await storeCount();
      if (countBefore !== null && countAfter !== null) {
        check('the store count is back where the suite found it', countAfter === countBefore, {
          before: countBefore,
          after: countAfter,
        });
      }
      await db.end();
    }
  }

  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\nSuite crashed:', error);
  process.exitCode = 1;
});
