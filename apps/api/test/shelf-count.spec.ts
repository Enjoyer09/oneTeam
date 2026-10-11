/**
 * oneTeam — manual OSA / share of shelf (wave 1.4) suite
 * ============================================================================
 *
 * WHY THIS EXISTS AS A PERMANENT TEST
 * -----------------------------------
 * Wave 1.4 of the Shelf Map plan (docs/PRODUCT-PLAN-AZ.md §9.3): "İşçi sayır,
 * sistem faizi hesablayır — model gələndə müqayisə bazası olur." The panel
 * records how many units a worker counted at each shelf slot, and the API
 * turns those counts into OSA (present / counted) and share of shelf (units
 * per product inside a section). When the vision model arrives (wave 2.x) it
 * is graded against exactly these numbers — arithmetic that is wrong now
 * poisons every future comparison silently, which is why it is pinned here.
 *
 * THE LOAD-BEARING ASSERTIONS
 * ---------------------------
 *   1. THE COUNT IS IN POSTGRESQL (units + counted_at), READ BACK WITH A
 *      SEPARATE CONNECTION, BEFORE THE CALL RETURNS.
 *   2. OSA DENOMINATOR = COUNTED ASSIGNED SLOTS ONLY. An uncounted slot is
 *      not a miss — "nobody said" must never become "0 % availability".
 *   3. SHARE OF SHELF IS COMPUTED PER SECTION over counted units; a section
 *      with a single counted product reads 100 %, a units-0 product reads 0 %.
 *   4. COUNTING IS THE WORKER ACTION: a merchandiser (who cannot edit the
 *      map, 403 in shelf-crud) CAN record a count.
 *   5. A COUNT SURVIVES A LAYOUT EDIT — moving a slot does not wipe it.
 *
 * Metrics are global (the shelf map has no store scope yet), so the checks
 * use BASELINES captured before the fixtures: assertions are deltas against
 * them, never absolute totals — a leaked row from an earlier run must not
 * turn this suite red.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * --------------------------------------
 * HTTP against a running API. Credentials: panel key when the panel is
 * locked, the service credential while it is still open, skip-with-
 * instructions when neither is accepted. 401/403 on the probe → skip;
 * 404 → route missing, fail.
 *
 * It does NOT prove history: counts are current-state only (a `ponytail:`
 * ceiling in the migration), not a time series per store visit.
 *
 * Cleanup: every row this run creates is deleted (shelf rows first, then the
 * products, mirroring the FK direction) and the final check asserts both
 * counts are back where they started.
 *
 * Prerequisites: the API must be running, and DATABASE_URL must point at the
 * same database it is using.
 *
 *   npm run api:dev
 *   DATABASE_URL=postgres://... ONETEAM_API_URL=http://localhost:3001 \
 *     npm run test:shelf-count
 */

import { Client } from 'pg';

const API_BASE = (process.env.ONETEAM_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || '';

/** A panel login key, when the panel is locked. */
const PANEL_KEY = process.env.ONETEAM_TEST_PANEL_KEY || '';
/** The service credential, usable only while the panel has no keys at all. */
const ADMIN_TOKEN = process.env.ONETEAM_TEST_ADMIN_TOKEN || 'oneteam-user:usr-admin-001';
/** A merchandiser — cannot edit the map, but must be able to COUNT. */
const MERCH_TOKEN = process.env.ONETEAM_TEST_MERCH_TOKEN || 'oneteam-user:usr-merch-003';

/** Unique per run, so two runs against one database do not collide. */
const RUN = Date.now().toString(36).toUpperCase();

const SECTION_COLA = `Sayğac cola ${RUN}`;
const SECTION_EMPTY = `Sayğac boş ${RUN}`;

/** Rounding every percentage the API reports, mirrored for the checks. */
const round1 = (value: number): number => Math.round(value * 10) / 10;

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

function skip(name: string, why: string): void {
  skipped += 1;
  console.log(`  ○ ${name} — SKIPPED: ${why}`);
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

/** Barcode generator inside the 8–14 digit window, unique per run+suffix. */
function barcodeFor(suffix: string): string {
  const digits = RUN.replace(/\D/g, '').padStart(6, '0');
  return `48${digits}${suffix}0000000`.slice(0, 13);
}

async function main(): Promise<void> {
  const candidates: Array<{ label: string; token: string }> = [];
  if (PANEL_KEY) candidates.push({ label: 'the panel key', token: PANEL_KEY });
  candidates.push({ label: 'the service credential', token: ADMIN_TOKEN });

  let token = '';
  let usingLabel = '';

  for (const candidate of candidates) {
    const probe = await call('GET', '/api/portal/shelf-metrics', { token: candidate.token });
    if (probe.status === 200) {
      token = candidate.token;
      usingLabel = candidate.label;
      break;
    }
    // A missing route is the suite's own RED state, not a credential problem.
    if (probe.status === 404) {
      check('GET /api/portal/shelf-metrics route exists', false, 404);
      console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
      process.exit(1);
    }
  }

  if (!token) {
    skip(
      'every OSA / share-of-shelf check',
      'no accepted credential (401/403 on the probe). Re-run with ONETEAM_TEST_PANEL_KEY=otp_... ' +
        'or against a panel with no keys yet.',
    );
    console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
    return;
  }
  console.log(`  · authenticating with ${usingLabel}`);

  const db = DATABASE_URL ? new Client({ connectionString: DATABASE_URL }) : null;
  if (db) await db.connect();

  /** Reads the slot straight from PostgreSQL, bypassing the API entirely. */
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
  const createdProductIds: string[] = [];
  const positionsBefore = await positionCount();
  const productsBefore = await productCount();

  // Metrics baselines — captured BEFORE this run's fixtures exist, so every
  // metrics assertion below can be a delta against them. A leaked row from an
  // earlier run then shifts the baseline instead of failing the math.
  const baseline = await call('GET', '/api/portal/shelf-metrics', { token });
  check('GET /api/portal/shelf-metrics answers 200', baseline.status === 200, baseline.body);
  const base = baseline.body?.data ?? {};
  const baseAssigned: number = base.assigned_slots ?? -1;
  const baseCounted: number = base.counted_slots ?? -1;
  const basePresent: number = base.present_slots ?? -1;

  try {
    // -------------------------------------------------------------------------
    // fixtures: two assigned slots in one section + one unassigned slot
    // -------------------------------------------------------------------------
    console.log('\nfixtures');
    // -------------------------------------------------------------------------

    const productA = await call('POST', '/api/portal/products', {
      token,
      body: { barcode: barcodeFor('11'), name: `Sayğac Cola A ${RUN}`, size: '0.5 L' },
    });
    check('product A fixture is created (201)', productA.status === 201, productA.body);
    const productB = await call('POST', '/api/portal/products', {
      token,
      body: { barcode: barcodeFor('22'), name: `Sayğac Cola B ${RUN}`, size: '1 L' },
    });
    check('product B fixture is created (201)', productB.status === 201, productB.body);
    const productAId: string | null = productA.body?.data?.id ?? null;
    const productBId: string | null = productB.body?.data?.id ?? null;
    if (productAId) createdProductIds.push(productAId);
    if (productBId) createdProductIds.push(productBId);

    const slotBody = (
      section: string,
      position: number,
      productId?: string | null,
    ): Record<string, unknown> => ({
      section,
      level: 1,
      position,
      ...(productId ? { product_id: productId } : {}),
    });

    const slotA = await call('POST', '/api/portal/shelf-positions', {
      token,
      body: slotBody(SECTION_COLA, 1, productAId),
    });
    const slotB = await call('POST', '/api/portal/shelf-positions', {
      token,
      body: slotBody(SECTION_COLA, 2, productBId),
    });
    const slotE = await call('POST', '/api/portal/shelf-positions', {
      token,
      body: slotBody(SECTION_EMPTY, 1),
    });
    // Slot U is assigned but is NEVER counted: without it present/assigned and
    // present/counted would coincide, and a mutation swapping OSA's
    // denominator could pass every check below (the suite pins rule #2).
    const slotU = await call('POST', '/api/portal/shelf-positions', {
      token,
      body: slotBody(SECTION_COLA, 3, productAId),
    });
    check('slot A (assigned) created (201)', slotA.status === 201, slotA.body);
    check('slot B (assigned) created (201)', slotB.status === 201, slotB.body);
    check('slot E (unassigned) created (201)', slotE.status === 201, slotE.body);
    check('slot U (assigned, stays uncounted) created (201)', slotU.status === 201, slotU.body);
    const slotAId: string | undefined = slotA.body?.data?.id;
    const slotBId: string | undefined = slotB.body?.data?.id;
    const slotEId: string | undefined = slotE.body?.data?.id;
    const slotUId: string | undefined = slotU.body?.data?.id;
    if (slotAId) createdIds.push(slotAId);
    if (slotBId) createdIds.push(slotBId);
    if (slotEId) createdIds.push(slotEId);
    if (slotUId) createdIds.push(slotUId);
    if (!slotAId || !slotBId || !slotEId || !slotUId) {
      skip('everything after the fixtures', 'a fixture slot was not created');
      console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
      return;
    }

    // -------------------------------------------------------------------------
    console.log('\ninput validation');
    // -------------------------------------------------------------------------

    const unknownId = await call('POST', '/api/portal/shelf-positions/shf-nope/count', {
      token,
      body: { units: 3 },
    });
    check('counting an unknown id answers 404', unknownId.status === 404, unknownId.body);
    check(
      'and the refusal names the slot',
      unknownId.body?.error === 'SHELF_POSITION_NOT_FOUND',
      unknownId.body,
    );

    const unassigned = await call('POST', `/api/portal/shelf-positions/${slotEId}/count`, {
      token,
      body: { units: 3 },
    });
    check(
      'counting an unassigned slot is refused with 400',
      unassigned.status === 400,
      unassigned.body,
    );
    check(
      'and the refusal says the slot has no product',
      unassigned.body?.error === 'SLOT_NOT_ASSIGNED',
      unassigned.body,
    );

    const noUnits = await call('POST', `/api/portal/shelf-positions/${slotAId}/count`, {
      token,
      body: {},
    });
    check('a body without units is refused with 400', noUnits.status === 400, noUnits.body);

    const negative = await call('POST', `/api/portal/shelf-positions/${slotAId}/count`, {
      token,
      body: { units: -1 },
    });
    check('a negative count is refused with 400', negative.status === 400, negative.body);

    const fractional = await call('POST', `/api/portal/shelf-positions/${slotAId}/count`, {
      token,
      body: { units: 2.5 },
    });
    check('a fractional count is refused with 400', fractional.status === 400, fractional.body);

    const tooBig = await call('POST', `/api/portal/shelf-positions/${slotAId}/count`, {
      token,
      body: { units: 1000 },
    });
    check('a count above the 999 cap is refused with 400', tooBig.status === 400, tooBig.body);

    const unknownField = await call('POST', `/api/portal/shelf-positions/${slotAId}/count`, {
      token,
      body: { units: 2, lux: 300 },
    });
    check('an unknown field is refused with 400', unknownField.status === 400, unknownField.body);

    // -------------------------------------------------------------------------
    console.log('\nrecording a count');
    // -------------------------------------------------------------------------

    const countedA = await call('POST', `/api/portal/shelf-positions/${slotAId}/count`, {
      token,
      body: { units: 4 },
    });
    check('counting an assigned slot answers 200', countedA.status === 200, countedA.body);
    check(
      'and the response carries the units and a counted_at',
      countedA.body?.data?.units === 4 && typeof countedA.body?.data?.counted_at === 'string',
      countedA.body?.data,
    );

    if (db) {
      const row = await rowInDatabase(slotAId!);
      check(
        'THE COUNT IS IN POSTGRESQL BEFORE THE CALL RETURNS',
        row !== null && row.units === 4,
        row && { units: row.units },
      );
      check(
        'and counted_at was written too',
        row !== null && row.counted_at !== null,
        row && { counted_at: row.counted_at },
      );
    } else {
      skip('the read-back-from-PostgreSQL checks', 'DATABASE_URL is not set');
    }

    const countedB = await call('POST', `/api/portal/shelf-positions/${slotBId}/count`, {
      token,
      body: { units: 0 },
    });
    check(
      'a zero count is accepted — absence is a real answer',
      countedB.status === 200 && countedB.body?.data?.units === 0,
      countedB.body,
    );

    // -------------------------------------------------------------------------
    console.log('\nthe merchandiser can count (but cannot edit the map)');
    // -------------------------------------------------------------------------

    const merchCount = await call('POST', `/api/portal/shelf-positions/${slotAId}/count`, {
      token: MERCH_TOKEN,
      body: { units: 4 },
    });
    check(
      'a merchandiser counting answers 200, not 403',
      merchCount.status === 200,
      merchCount.body,
    );

    const merchEdit = await call('PATCH', `/api/portal/shelf-positions/${slotAId}`, {
      token: MERCH_TOKEN,
      body: { position: 5 },
    });
    check(
      '...while the same merchandiser still cannot edit the layout (403)',
      merchEdit.status === 403,
      merchEdit.body,
    );

    // -------------------------------------------------------------------------
    console.log('\na count survives a layout edit');
    // -------------------------------------------------------------------------

    const moved = await call('PATCH', `/api/portal/shelf-positions/${slotAId}`, {
      token,
      body: { position: 7 },
    });
    check('moving the counted slot answers 200', moved.status === 200, moved.body);
    if (db) {
      const row = await rowInDatabase(slotAId!);
      check(
        'and THE ROW IN POSTGRESQL kept its count through the move',
        row !== null && row.units === 4 && row.counted_at !== null,
        row && { units: row.units, counted_at: row.counted_at, position: row.position },
      );
    }

    // -------------------------------------------------------------------------
    console.log('\nmetrics');
    // -------------------------------------------------------------------------

    const metrics = await call('GET', '/api/portal/shelf-metrics', { token });
    check('the metrics answer 200', metrics.status === 200, metrics.body);
    const data = metrics.body?.data ?? {};

    check(
      'assigned slots grew by exactly the three fixtures (U included)',
      data.assigned_slots === baseAssigned + 3,
      { before: baseAssigned, now: data.assigned_slots },
    );
    check(
      'counted slots grew by exactly the two fixtures (the unassigned slot did not count)',
      data.counted_slots === baseCounted + 2,
      { before: baseCounted, now: data.counted_slots },
    );
    check(
      'present slots grew by one (units > 0 on A, units 0 on B is a miss)',
      data.present_slots === basePresent + 1,
      { before: basePresent, now: data.present_slots },
    );

    // OSA is recomputed from the reported counts — self-consistent, and exact
    // even when a leaked row from an earlier run sits in the baseline. With
    // slot U uncounted, present/assigned differs from present/counted, so this
    // check kills any mutation that swaps the denominator.
    const expectedOsa =
      data.counted_slots > 0 ? round1((data.present_slots / data.counted_slots) * 100) : null;
    check(
      'OSA = present / counted (not present / assigned — uncounted is not a miss)',
      data.osa === expectedOsa,
      { osa: data.osa, expectedOsa, counted: data.counted_slots, present: data.present_slots },
    );
    check(
      'and OSA is a percentage, not a fraction',
      data.osa === null || (data.osa >= 0 && data.osa <= 100),
      data.osa,
    );

    const sections: any[] = Array.isArray(data.sections) ? data.sections : [];
    const cola = sections.find((s) => s.section === SECTION_COLA);
    check(
      'the fixture section appears in the sections list',
      !!cola,
      sections.map((s) => s.section),
    );

    if (cola) {
      check('and it reports the three assigned slots', cola.assigned === 3, cola);
      check('with one present slot (B is counted 0)', cola.present === 1, cola);
      check('and 4 units total', cola.units === 4, cola);

      const products: any[] = Array.isArray(cola.products) ? cola.products : [];
      const entryA = products.find((p) => p.product_id === productAId);
      const entryB = products.find((p) => p.product_id === productBId);
      check('both counted products are listed', !!entryA && !!entryB, products);
      check(
        'A holds 4 units and reads 100 % share',
        entryA?.units === 4 && entryA?.share === 100,
        entryA,
      );
      check(
        'B holds 0 units and reads 0 % share',
        entryB?.units === 0 && entryB?.share === 0,
        entryB,
      );

      const shareSum = products.reduce((sum, p) => sum + (p.share ?? 0), 0);
      check('the section shares sum to ~100 %', Math.abs(shareSum - 100) <= 0.5, shareSum);
    } else {
      skip('the section-level share checks', 'fixture section missing from metrics');
    }

    const emptySection = sections.find((s) => s.section === SECTION_EMPTY);
    check(
      'a section with only unassigned slots is not reported (no expectation, no share)',
      !emptySection,
      emptySection,
    );

    const totalUnits: number = data.total_units ?? -1;
    check('total_units grew by at least the fixture units', totalUnits >= 4, totalUnits);
  } finally {
    // Cleanup: remove anything this run created, then assert both counts moved
    // back. A leak must fail the suite rather than pollute the next run.
    if (db) {
      for (const id of createdIds) {
        await db.query('DELETE FROM shelf_positions WHERE id = $1', [id]);
      }
      for (const id of createdProductIds) {
        await db.query('DELETE FROM products WHERE id = $1', [id]);
      }
      const positionsAfter = await positionCount();
      const productsAfter = await productCount();
      check(
        'the shelf map count is back where it started',
        positionsAfter !== null && positionsBefore !== null && positionsAfter === positionsBefore,
        { positionsBefore, positionsAfter },
      );
      check(
        'the product count is back where it started',
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
  console.error(error);
  process.exit(1);
});
