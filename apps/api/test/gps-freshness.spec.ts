#!/usr/bin/env node
/**
 * A GPS fix is evidence of *when* as well as *where*.
 * ============================================================================
 *
 * THE HOLE
 * --------
 * `field.service.ts` decides whether a submission carries a real fix with one
 * expression:
 *
 *     const hasRealFix =
 *       typeof payload.latitude === 'number' && typeof payload.longitude === 'number';
 *
 * It checks that the numbers exist. It never checks *when* they were taken — and
 * nothing upstream can, because no client sends a timestamp at all:
 *
 *     git grep locatedAt fixTimestamp locationTime capturedAt gpsTime
 *     (no matches anywhere in apps/, src/, mobile/)
 *
 * So the coordinate pair is a bare claim with no age. A device that acquired a
 * fix once — in the car park, at 09:00 — can replay those same two numbers at
 * 21:00, from anywhere, and the audit reads exactly like a legitimate one. The
 * geofence check downstream cannot catch it: the coordinates ARE inside the
 * radius. They are simply not *now*.
 *
 * This is the same shape as the photo hole `photo-provenance.spec.ts` closes,
 * and the same reason the existing photo guard measures SIZE but not AGE: a
 * bounded check that cannot fail is decoration, so the age check has to exist
 * and the client has to be able to satisfy it.
 *
 * WHY THE FIX IS "REJECT A STALE FIX", NOT "TRUST IT"
 * ---------------------------------------------------
 * Falling back to the store's coordinates when a fix is stale — which is what
 * `field.service.ts` already does when no fix arrives at all — would file the
 * audit against the store's own position and pass the geofence trivially. That
 * is worse than refusing: it manufactures a passing result from no evidence. A
 * stale fix is refused, and the worker re-acquires.
 *
 * WHAT IS ASSERTED HERE
 * ---------------------
 * The guard is a pure predicate, so it is tested as one. The wiring into the
 * submission path is asserted by reading the call site (see the last check),
 * because a submission needs a database and this suite deliberately has none —
 * the point of a unit test is that it is runnable.
 */

import { isFixFresh, MAX_FIX_AGE_MS } from '../src/modules/portal/gps-freshness';

const REPO_ROOT = path.resolve(__dirname, '../../..');

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}`);
    if (detail !== undefined) console.log(`      got: ${JSON.stringify(detail)}`);
  }
}

const NOW = new Date('2026-10-05T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

async function run(): Promise<void> {
  console.log('\n--- a fix taken now ---');
  check('a fix timestamped this instant is fresh', isFixFresh(at(0).toISOString(), NOW));
  check('a fix taken a minute ago is fresh', isFixFresh(at(-60_000).toISOString(), NOW));

  console.log('\n--- a fix from another day ---');
  // The whole point. A pair of coordinates inside the geofence, captured hours
  // earlier, must not pass as a present location.
  check('a fix from 8 hours ago is refused', !isFixFresh(at(-8 * 3600_000).toISOString(), NOW), {
    timestamp: at(-8 * 3600_000).toISOString(),
  });
  check('a fix from yesterday is refused', !isFixFresh(at(-24 * 3600_000).toISOString(), NOW));
  check('a fix from last week is refused', !isFixFresh(at(-7 * 24 * 3600_000).toISOString(), NOW));

  console.log('\n--- the boundary, because a boundary nobody tested is a guess ---');
  check(
    'a fix one millisecond inside the limit is fresh',
    isFixFresh(at(-(MAX_FIX_AGE_MS - 1)).toISOString(), NOW),
    { MAX_FIX_AGE_MS },
  );
  check(
    'a fix exactly at the limit is fresh (the limit is inclusive)',
    isFixFresh(at(-MAX_FIX_AGE_MS).toISOString(), NOW),
  );
  check(
    'a fix one millisecond past the limit is refused',
    !isFixFresh(at(-(MAX_FIX_AGE_MS + 1)).toISOString(), NOW),
  );
  check(
    'a fix from the future is refused, not honoured',
    // A device with a wrong clock must not be able to mint an eternal fix by
    // reporting tomorrow. Small skew is tolerated; a day ahead is not.
    !isFixFresh(at(2 * 3600_000).toISOString(), NOW),
    { timestamp: at(2 * 3600_000).toISOString() },
  );

  console.log('\n--- nothing to judge ---');
  // An absent timestamp cannot be called fresh, and cannot be called stale
  // either — it is a different case, and it must not be silently accepted.
  check('an absent timestamp is not fresh', !isFixFresh(undefined, NOW));
  check('a null timestamp is not fresh', !isFixFresh(null, NOW));
  check('an empty timestamp is not fresh', !isFixFresh('', NOW));
  check('an unparseable timestamp is not fresh', !isFixFresh('yesterday afternoon', NOW));

  console.log('\n--- the guard is actually wired in ---');
  // A predicate that nothing calls is a test of a function nobody runs. This
  // reads the call site so the suite cannot stay green after the guard is
  // unwired.
  // Read through the repo root rather than `import.meta`, which this file's
  // CommonJS output rejects at compile time — the same reason scripts/ is .mjs.
  const source = await readFile(
    path.join(REPO_ROOT, 'apps/api/src/modules/portal/field.service.ts'),
    'utf8',
  );
  check(
    'field.service.ts imports and calls isFixFresh',
    source.includes('isFixFresh') && /isFixFresh\s*\(/.test(source),
  );

  console.log(`\n${passed}/${passed + failed} gps-freshness checks passed`);
  if (failed > 0) process.exitCode = 1;
}

// Imported lazily so the failure above is legible rather than a module error.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

run().catch((err) => {
  console.error('❌ gps-freshness suite failed:', err);
  process.exitCode = 1;
});
