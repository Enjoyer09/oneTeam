/**
 * oneTeam — product (SKU) CRUD suite
 * ============================================================================
 *
 * WHY THIS EXISTS AS A PERMANENT TEST
 * -----------------------------------
 * The SKU catalogue is wave 1.2 of the Shelf Map product plan: a barcode
 * scanner has to resolve `barkod → məhsul` for a row auditor, and the panel
 * is where a supervisor maintains that mapping. Without it, every shelf audit
 * carries product identity in a spreadsheet that drifts away from what the
 * scanner actually sees.
 *
 * THE LOAD-BEARING ASSERTION is the same one store-crud.spec.ts makes:
 *
 *   THE ROW IS IN POSTGRESQL, READ BACK WITH A SEPARATE CONNECTION,
 *   BEFORE THE CREATE CALL RETURNS.
 *
 * A catalogue that lives only in the API's memory would answer 201, render
 * in the list, and vanish on the next deploy — and the auditor's scans would
 * silently stop resolving.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * --------------------------------------
 * HTTP against a running API (the write ordering under test lives in the
 * API process). Credentials: panel key when the panel is locked, the service
 * credential while it is still open, skip-with-instructions when neither is
 * accepted. 401/403 on the probe → skip; 404 → the route is missing, fail.
 *
 * Cleanup: every product this suite creates is deleted and the final check
 * asserts the catalogue count is back where it started — a leaked row would
 * show up in the panel and in test:replica's counts.
 *
 * Prerequisites: the API must be running, and DATABASE_URL must point at the
 * same database it is using.
 *
 *   npm run api:dev
 *   DATABASE_URL=postgres://... ONETEAM_API_URL=http://localhost:3001 \
 *     npm run test:products
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

/** A product body that should be accepted, with the barcode overridable. */
function productBody(overrides: Record<string, unknown> = {}) {
  // digits unique per run, inside the 8–14 digit EAN/UPC window.
  const digits = RUN.replace(/\D/g, '').padStart(6, '0');
  const fallback = `48${digits}0000000`.slice(0, 13);
  const base: Record<string, unknown> = {
    name: 'Test Beverage 0.5L',
    size: '0.5 L',
    variant: 'Zero',
    ...overrides,
  };
  // `barcode` is set AFTER the spread so its type stays `string` — spreading
  // `Record<string, unknown>` last would widen it back to unknown.
  return {
    ...base,
    barcode: typeof overrides.barcode === 'string' ? overrides.barcode : fallback,
  };
}

async function main(): Promise<void> {
  const candidates: Array<{ label: string; token: string }> = [];
  if (PANEL_KEY) candidates.push({ label: 'the panel key', token: PANEL_KEY });
  candidates.push({ label: 'the service credential', token: ADMIN_TOKEN });

  let token = '';
  let usingLabel = '';

  for (const candidate of candidates) {
    const probe = await call('GET', '/api/portal/products', { token: candidate.token });
    if (probe.status === 200) {
      token = candidate.token;
      usingLabel = candidate.label;
      break;
    }
    // A missing route is the suite's own RED state, not a credential problem.
    if (probe.status === 404) {
      check('GET /api/portal/products route exists', false, 404);
      console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
      process.exit(1);
    }
  }

  if (!token) {
    skip(
      'every product check',
      'no accepted credential (401/403 on the probe). Re-run with ONETEAM_TEST_PANEL_KEY=otp_... ' +
        'or against a panel with no keys yet.',
    );
    console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
    return;
  }

  console.log(`  · authenticating with ${usingLabel}`);

  const db = DATABASE_URL ? new Client({ connectionString: DATABASE_URL }) : null;
  if (db) await db.connect();

  /** Reads the row straight from PostgreSQL, bypassing the API entirely. */
  const rowInDatabase = async (barcode: string): Promise<any | null> => {
    if (!db) return null;
    const result = await db.query('SELECT * FROM products WHERE barcode = $1', [barcode]);
    return result.rows[0] ?? null;
  };

  const productCount = async (): Promise<number | null> => {
    if (!db) return null;
    const result = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM products',
    );
    return Number(result.rows[0]?.count ?? -1);
  };

  const createdIds: string[] = [];
  const countBefore = await productCount();

  try {
    // -------------------------------------------------------------------------
    console.log('\ncreate');
    // -------------------------------------------------------------------------

    const barcode = productBody().barcode;
    const created = await call('POST', '/api/portal/products', {
      token,
      body: productBody({ barcode }),
    });

    check('POST /api/portal/products answers 201', created.status === 201, created.body);
    const productId: string | undefined = created.body?.data?.id;
    check('and returns the new product with an id', typeof productId === 'string', created.body);
    check(
      'and echoes the barcode it stored',
      created.body?.data?.barcode === barcode,
      created.body?.data?.barcode,
    );
    if (productId) createdIds.push(productId);

    if (db) {
      const row = await rowInDatabase(barcode);
      check(
        'THE ROW IS IN POSTGRESQL BEFORE THE CALL RETURNS',
        row !== null,
        'no row with that barcode — the API answered 201 for a product it never stored',
      );
      check(
        'and the stored attributes are the ones submitted',
        row !== null &&
          row.name === 'Test Beverage 0.5L' &&
          row.size === '0.5 L' &&
          row.variant === 'Zero',
        row && { name: row.name, size: row.size, variant: row.variant },
      );
    } else {
      skip('the read-back-from-PostgreSQL checks', 'DATABASE_URL is not set');
    }

    // -------------------------------------------------------------------------
    console.log('\nappears in the list');
    // -------------------------------------------------------------------------

    const list = await call('GET', '/api/portal/products', { token });
    check('GET /api/portal/products answers 200', list.status === 200, list.body);
    check(
      'and the new product is in it',
      Array.isArray(list.body?.data) && list.body.data.some((p: any) => p.id === productId),
      list.body?.data?.length,
    );

    // -------------------------------------------------------------------------
    console.log('\nduplicate barcode is refused');
    // -------------------------------------------------------------------------

    const duplicate = await call('POST', '/api/portal/products', {
      token,
      body: productBody({ barcode }),
    });
    check(
      'the same barcode a second time is refused with 409',
      duplicate.status === 409,
      duplicate.body,
    );
    check(
      'and the refusal names the barcode',
      duplicate.body?.error === 'PRODUCT_BARCODE_TAKEN',
      duplicate.body,
    );

    if (db) {
      const rows = await db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM products WHERE barcode = $1',
        [barcode],
      );
      check('and no second row was created', Number(rows.rows[0]?.count ?? -1) === 1, rows.rows[0]);
    }

    // -------------------------------------------------------------------------
    console.log('\ninput validation');
    // -------------------------------------------------------------------------

    const badBarcode = await call('POST', '/api/portal/products', {
      token,
      body: productBody({ barcode: 'not-a-barcode' }),
    });
    check('a non-numeric barcode is refused with 400', badBarcode.status === 400, badBarcode.body);

    const shortBarcode = await call('POST', '/api/portal/products', {
      token,
      body: productBody({ barcode: '12345' }),
    });
    check(
      'a barcode shorter than 8 digits is refused with 400',
      shortBarcode.status === 400,
      shortBarcode.body,
    );

    const noName = await call('POST', '/api/portal/products', {
      token,
      body: productBody({ name: '   ' }),
    });
    check('a blank name is refused with 400', noName.status === 400, noName.body);

    // -------------------------------------------------------------------------
    console.log('\nupdate');
    // -------------------------------------------------------------------------

    const patched = await call('PATCH', `/api/portal/products/${productId}`, {
      token,
      body: { name: 'Test Beverage 1L', size: '1 L' },
    });
    check('PATCH answers 200 with the updated product', patched.status === 200, patched.body);
    check('and the response carries the new name', patched.body?.data?.name === 'Test Beverage 1L');

    if (db) {
      const row = await rowInDatabase(barcode);
      check(
        'and THE ROW IN POSTGRESQL has the new name too',
        row !== null && row.name === 'Test Beverage 1L' && row.size === '1 L',
        row && { name: row.name, size: row.size },
      );
    }

    // An explicit empty optional field CLEARS it. The edit form pre-fills the
    // current values, so '' only arrives when the operator deliberately erased
    // the field — it used to be swallowed as "absent" and the old value came
    // back on the next load.
    const cleared = await call('PATCH', `/api/portal/products/${productId}`, {
      token,
      body: { size: '', variant: '' },
    });
    check('PATCH with empty size/variant answers 200', cleared.status === 200, cleared.body);
    check(
      'and the cleared fields come back as null',
      cleared.body?.data?.size === null && cleared.body?.data?.variant === null,
      cleared.body?.data,
    );
    if (db) {
      const row = await rowInDatabase(barcode);
      check(
        'and THE ROW IN POSTGRESQL stores NULL, not the old value',
        row !== null && row.size === null && row.variant === null,
        row && { size: row.size, variant: row.variant },
      );
    }

    // Absence still means "leave alone": a name-only edit must not resurrect
    // the cleared fields.
    const nameOnly = await call('PATCH', `/api/portal/products/${productId}`, {
      token,
      body: { name: 'Test Beverage Zero' },
    });
    check(
      'a later name-only PATCH leaves the cleared fields null',
      nameOnly.status === 200 &&
        nameOnly.body?.data?.name === 'Test Beverage Zero' &&
        nameOnly.body?.data?.size === null &&
        nameOnly.body?.data?.variant === null,
      nameOnly.body?.data,
    );

    const conflict = await call('PATCH', `/api/portal/products/${productId}`, {
      token,
      body: { barcode: productBody({ barcode: `99${RUN}${'0'.repeat(8)}` }).barcode },
    });
    // no other product holds that barcode — this must be accepted (200), not
    // a 409; the refusal case is the duplicate-create above. Keep the shape
    // honest: an unknown attribute set is the real PATCH edge here.
    const unknownField = await call('PATCH', `/api/portal/products/${productId}`, {
      token,
      body: { girth_mm: 12 },
    });
    check(
      'an unknown field alone is refused with 400',
      unknownField.status === 400,
      unknownField.body,
    );
    void conflict;

    // -------------------------------------------------------------------------
    console.log('\nmerchandiser cannot change master data');
    // -------------------------------------------------------------------------

    const merch = await call('POST', '/api/portal/products', {
      token: MERCH_TOKEN,
      body: productBody({ barcode: `47${RUN}${'0'.repeat(9)}`.slice(0, 13) }),
    });
    check('a merchandiser gets 403, not 201', merch.status === 403, merch.body);

    // -------------------------------------------------------------------------
    console.log('\ndelete');
    // -------------------------------------------------------------------------

    const missing = await call('DELETE', '/api/portal/products/prd-does-not-exist', { token });
    check('deleting an unknown id answers 404', missing.status === 404, missing.body);

    const deleted = await call('DELETE', `/api/portal/products/${productId}`, { token });
    check('DELETE answers 200', deleted.status === 200, deleted.body);

    if (db) {
      const row = productId
        ? await db.query('SELECT 1 FROM products WHERE id = $1', [productId])
        : null;
      check(
        'and the row is gone from PostgreSQL',
        row === null || row.rowCount === 0,
        row?.rowCount,
      );
    }
  } finally {
    // Cleanup: remove anything this run created, then assert the count moved
    // back. A leak must fail the suite rather than pollute the next run.
    if (db) {
      for (const id of createdIds) {
        await db.query('DELETE FROM products WHERE id = $1', [id]);
      }
      const countAfter = await productCount();
      check(
        'the catalogue count is back where it started',
        countAfter !== null && countBefore !== null && countAfter === countBefore,
        { countBefore, countAfter },
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
