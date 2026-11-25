/**
 * oneTeam — shelf map (rəf xəritəsi) CRUD suite
 * ============================================================================
 *
 * WHY THIS EXISTS AS A PERMANENT TEST
 * -----------------------------------
 * Wave 1.3 of the Shelf Map plan (docs/PRODUCT-PLAN-AZ.md §9.3): the shelf map
 * is the structured base the later planogram comparison reads — "which product
 * belongs at (bölmə, səviyyə, mövqe)" — and wave 2.2 metrics are arithmetic
 * over exactly these rows. A map that only lives in the API's memory would
 * answer 201, render in the panel, and vanish on restart, and every later
 * comparison would silently drift from what the supervisor last saw.
 *
 * THE LOAD-BEARING ASSERTION is the one store-crud and product-crud make:
 *
 *   THE ROW IS IN POSTGRESQL, READ BACK WITH A SEPARATE CONNECTION,
 *   BEFORE THE CREATE CALL RETURNS.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * --------------------------------------
 * HTTP against a running API. Credentials: panel key when the panel is locked,
 * the service credential while it is still open, skip-with-instructions when
 * neither is accepted. 401/403 on the probe → skip; 404 → route missing, fail.
 *
 * The product-referencing checks also pin the FK contract promised by
 * 20261007000001_add_products.sql ("wave 1.3 will add their own RESTRICT
 * constraint"): a product sitting on a shelf cannot be deleted until the map
 * lets go of it, and the refusal is a readable 409 — not a 503.
 *
 * Cleanup: every row this suite creates is deleted (shelf rows first, then the
 * product, mirroring the FK direction) and the final check asserts both counts
 * are back where they started.
 *
 * Prerequisites: the API must be running, and DATABASE_URL must point at the
 * same database it is using.
 *
 *   npm run api:dev
 *   DATABASE_URL=postgres://... ONETEAM_API_URL=http://localhost:3001 \
 *     npm run test:shelf
 */

import { Client } from 'pg';
import { serviceToken } from './helpers/service-token';

const API_BASE = (process.env.ONETEAM_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || '';

/** A panel login key, when the panel is locked. */
const PANEL_KEY = process.env.ONETEAM_TEST_PANEL_KEY || '';
/** The service credential, usable only while the panel has no keys at all. */
const ADMIN_TOKEN = process.env.ONETEAM_TEST_ADMIN_TOKEN || serviceToken('usr-admin-001');
/** A merchandiser — the role that must not change master data. */
const MERCH_TOKEN = process.env.ONETEAM_TEST_MERCH_TOKEN || serviceToken('usr-merch-003');

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
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/** A shelf position body that should be accepted. */
function positionBody(overrides: Record<string, unknown> = {}) {
  return {
    section: `Kola rəfi ${RUN}`,
    level: 2,
    position: 5,
    ...overrides,
  };
}

async function main(): Promise<void> {
  const candidates: Array<{ label: string; token: string }> = [];
  if (PANEL_KEY) candidates.push({ label: 'the panel key', token: PANEL_KEY });
  candidates.push({ label: 'the service credential', token: ADMIN_TOKEN });

  let token = '';
  let usingLabel = '';

  for (const candidate of candidates) {
    const probe = await call('GET', '/api/portal/shelf-positions', { token: candidate.token });
    if (probe.status === 200) {
      token = candidate.token;
      usingLabel = candidate.label;
      break;
    }
    // A missing route is the suite's own RED state, not a credential problem.
    if (probe.status === 404) {
      check('GET /api/portal/shelf-positions route exists', false, 404);
      console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
      process.exit(1);
    }
  }

  if (!token) {
    skip(
      'every shelf map check',
      'no accepted credential (401/403 on the probe). Re-run with ONETEAM_TEST_PANEL_KEY=otp_... ' +
        'or against a panel with no keys yet.',
    );
    console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
    return;
  }

  console.log(`  · authenticating with ${usingLabel}`);

  const db = DATABASE_URL ? new Client({ connectionString: DATABASE_URL }) : null;
  if (db) await db.connect();

  /** Reads the position straight from PostgreSQL, bypassing the API entirely. */
  const rowInDatabase = async (id: string): Promise<any | null> => {
    if (!db) return null;
    const result = await db.query('SELECT * FROM shelf_positions WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  };

  const positionCount = async (): Promise<number | null> => {
    if (!db) return null;
    const result = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM shelf_positions',
    );
    return Number(result.rows[0]?.count ?? -1);
  };

  const productCount = async (): Promise<number | null> => {
    if (!db) return null;
    const result = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM products',
    );
    return Number(result.rows[0]?.count ?? -1);
  };

  const createdIds: string[] = [];
  let createdProductId: string | null = null;
  const positionsBefore = await positionCount();
  const productsBefore = await productCount();

  try {
    // -------------------------------------------------------------------------
    console.log('\ncreate');
    // -------------------------------------------------------------------------

    const created = await call('POST', '/api/portal/shelf-positions', {
      token,
      body: positionBody(),
    });

    check('POST /api/portal/shelf-positions answers 201', created.status === 201, created.body);
    const positionId: string | undefined = created.body?.data?.id;
    check('and returns the new position with an id', typeof positionId === 'string', created.body);
    check(
      'and echoes the coordinates it stored',
      created.body?.data?.section === `Kola rəfi ${RUN}` &&
        created.body?.data?.level === 2 &&
        created.body?.data?.position === 5,
      created.body?.data,
    );
    if (positionId) createdIds.push(positionId);

    if (db) {
      const row = await rowInDatabase(positionId!);
      check(
        'THE ROW IS IN POSTGRESQL BEFORE THE CALL RETURNS',
        row !== null,
        'no row with that id — the API answered 201 for a position it never stored',
      );
      check(
        'and the stored coordinates are the ones submitted',
        row !== null && row.section === `Kola rəfi ${RUN}` && row.level === 2 && row.position === 5,
        row && { section: row.section, level: row.level, position: row.position },
      );
    } else {
      skip('the read-back-from-PostgreSQL checks', 'DATABASE_URL is not set');
    }

    // -------------------------------------------------------------------------
    console.log('\nappears in the list');
    // -------------------------------------------------------------------------

    const list = await call('GET', '/api/portal/shelf-positions', { token });
    check('GET /api/portal/shelf-positions answers 200', list.status === 200, list.body);
    check(
      'and the new position is in it',
      Array.isArray(list.body?.data) && list.body.data.some((p: any) => p.id === positionId),
      list.body?.data?.length,
    );

    // -------------------------------------------------------------------------
    console.log('\nduplicate coordinates are refused');
    // -------------------------------------------------------------------------

    const duplicate = await call('POST', '/api/portal/shelf-positions', {
      token,
      body: positionBody(),
    });
    check(
      'the same (section, level, position) a second time is refused with 409',
      duplicate.status === 409,
      duplicate.body,
    );
    check(
      'and the refusal names the conflict',
      duplicate.body?.error === 'SHELF_POSITION_TAKEN',
      duplicate.body,
    );

    if (db) {
      const rows = await db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM shelf_positions WHERE section = $1 AND level = $2 AND position = $3',
        [`Kola rəfi ${RUN}`, 2, 5],
      );
      check('and no second row was created', Number(rows.rows[0]?.count ?? -1) === 1, rows.rows[0]);
    }

    // -------------------------------------------------------------------------
    console.log('\ninput validation');
    // -------------------------------------------------------------------------

    const badLevel = await call('POST', '/api/portal/shelf-positions', {
      token,
      body: positionBody({ level: 0 }),
    });
    check('a level below 1 is refused with 400', badLevel.status === 400, badLevel.body);

    const badPosition = await call('POST', '/api/portal/shelf-positions', {
      token,
      body: positionBody({ position: -3 }),
    });
    check('a position below 1 is refused with 400', badPosition.status === 400, badPosition.body);

    const fractional = await call('POST', '/api/portal/shelf-positions', {
      token,
      body: positionBody({ level: 1.5 }),
    });
    check('a fractional level is refused with 400', fractional.status === 400, fractional.body);

    const noSection = await call('POST', '/api/portal/shelf-positions', {
      token,
      body: positionBody({ section: '   ' }),
    });
    check('a blank section is refused with 400', noSection.status === 400, noSection.body);

    const unknownField = await call('POST', '/api/portal/shelf-positions', {
      token,
      body: positionBody({ drawer_count: 4 }),
    });
    check('an unknown field is refused with 400', unknownField.status === 400, unknownField.body);

    // Free coordinates, so the only thing wrong with this request is the
    // product reference — an occupied slot would answer 409 instead.
    const unknownProduct = await call('POST', '/api/portal/shelf-positions', {
      token,
      body: positionBody({ position: 6, product_id: 'prd-does-not-exist' }),
    });
    check(
      'a product_id that names no product is refused with 400',
      unknownProduct.status === 400,
      unknownProduct.body,
    );

    // -------------------------------------------------------------------------
    console.log('\nassigning a product to a position');
    // -------------------------------------------------------------------------

    // The barcode must be unique per run and inside the 8–14 digit window.
    const digits = RUN.replace(/\D/g, '').padStart(6, '0');
    const barcode = `48${digits}0000000`.slice(0, 13);
    const product = await call('POST', '/api/portal/products', {
      token,
      body: { barcode, name: 'Shelf Map Beverage', size: '0.5 L', variant: 'Zero' },
    });
    check('the product fixture is created (201)', product.status === 201, product.body);
    createdProductId = product.body?.data?.id ?? null;

    if (createdProductId) {
      const assigned = await call('POST', '/api/portal/shelf-positions', {
        token,
        body: positionBody({ position: 7, product_id: createdProductId }),
      });
      check(
        'a position with a real product_id is accepted (201)',
        assigned.status === 201,
        assigned.body,
      );
      const assignedId: string | undefined = assigned.body?.data?.id;
      if (assignedId) createdIds.push(assignedId);

      if (db && assignedId) {
        const row = await rowInDatabase(assignedId);
        check(
          'and the product reference is in PostgreSQL too',
          row !== null && row.product_id === createdProductId,
          row && { product_id: row.product_id },
        );
      }
    } else {
      skip('the product assignment checks', 'product fixture was not created');
    }

    // -------------------------------------------------------------------------
    console.log('\nupdate');
    // -------------------------------------------------------------------------

    const patched = await call('PATCH', `/api/portal/shelf-positions/${positionId}`, {
      token,
      body: { level: 3, position: 9 },
    });
    check('PATCH answers 200 with the updated position', patched.status === 200, patched.body);
    check(
      'and the response carries the new coordinates',
      patched.body?.data?.level === 3 && patched.body?.data?.position === 9,
      patched.body?.data,
    );

    if (db) {
      const row = await rowInDatabase(positionId!);
      check(
        'and THE ROW IN POSTGRESQL has the new coordinates too',
        row !== null && row.level === 3 && row.position === 9,
        row && { level: row.level, position: row.position },
      );
    }

    const unknownPatch = await call('PATCH', `/api/portal/shelf-positions/${positionId}`, {
      token,
      body: { lighting_lux: 300 },
    });
    check(
      'an unknown field alone is refused with 400',
      unknownPatch.status === 400,
      unknownPatch.body,
    );

    // Moving onto an occupied slot is the same conflict as creating one.
    const bump = await call('POST', '/api/portal/shelf-positions', {
      token,
      body: positionBody({ level: 3, position: 9 }),
    });
    check('a second position cannot take an occupied slot (409)', bump.status === 409, bump.body);
    if (bump.status === 409) {
      // It was refused — it never got an id, nothing to clean up.
    } else if (typeof bump.body?.data?.id === 'string') {
      createdIds.push(bump.body.data.id);
    }

    const moved = await call('PATCH', `/api/portal/shelf-positions/${positionId}`, {
      token,
      body: { position: 11 },
    });
    check(
      'moving the position off the occupied slot is accepted',
      moved.status === 200,
      moved.body,
    );

    // -------------------------------------------------------------------------
    console.log('\nmerchandiser cannot change master data');
    // -------------------------------------------------------------------------

    const merch = await call('POST', '/api/portal/shelf-positions', {
      token: MERCH_TOKEN,
      body: positionBody({ section: `Məhsul yoxdur ${RUN}`, level: 9 }),
    });
    check('a merchandiser gets 403, not 201', merch.status === 403, merch.body);

    // -------------------------------------------------------------------------
    console.log('\na product on the shelf cannot be deleted');
    // -------------------------------------------------------------------------

    if (createdProductId) {
      const refused = await call('DELETE', `/api/portal/products/${createdProductId}`, { token });
      check(
        'DELETE of an assigned product answers 409, not 503',
        refused.status === 409,
        refused.body,
      );
      check(
        'and the refusal says the product is on a shelf',
        refused.body?.error === 'PRODUCT_ON_SHELF',
        refused.body,
      );
    } else {
      skip('the product-on-shelf refusal checks', 'product fixture was not created');
    }

    // -------------------------------------------------------------------------
    console.log('\ndelete');
    // -------------------------------------------------------------------------

    const missing = await call('DELETE', '/api/portal/shelf-positions/shf-does-not-exist', {
      token,
    });
    check('deleting an unknown id answers 404', missing.status === 404, missing.body);

    for (const id of [...createdIds]) {
      const deleted = await call('DELETE', `/api/portal/shelf-positions/${id}`, { token });
      check(`DELETE ${id} answers 200`, deleted.status === 200, deleted.body);

      if (db) {
        const row = await rowInDatabase(id);
        check(
          `and row ${id} is gone from PostgreSQL`,
          row === null,
          row && { section: row.section },
        );
      }
    }

    // With every shelf row gone the FK no longer blocks the product delete.
    if (createdProductId) {
      const deleted = await call('DELETE', `/api/portal/products/${createdProductId}`, { token });
      check(
        'once the map lets go, the product delete succeeds (200)',
        deleted.status === 200,
        deleted.body,
      );
    }
  } finally {
    // Cleanup: remove anything this run created, then assert both counts moved
    // back. A leak must fail the suite rather than pollute the next run.
    if (db) {
      for (const id of createdIds) {
        await db.query('DELETE FROM shelf_positions WHERE id = $1', [id]);
      }
      if (createdProductId) {
        await db.query('DELETE FROM products WHERE id = $1', [createdProductId]);
      }
      const positionsAfter = await positionCount();
      const productsAfter = await productCount();
      check(
        'the shelf map count is back where it started',
        positionsAfter !== null && positionsBefore !== null && positionsAfter === positionsBefore,
        { positionsBefore, positionsAfter },
      );
      check(
        'the catalogue count is back where it started',
        productsAfter !== null && productsBefore !== null && productsAfter === productsBefore,
        { productsBefore, productsAfter },
      );
      await db.end();
    }
  }

  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('suite crashed:', error);
  process.exit(1);
});
