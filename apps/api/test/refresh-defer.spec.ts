/**
 * The cross-replica refresh must not swap the in-memory arrays while a local
 * write is still in flight.
 *
 * WHY THIS EXISTS
 * ---------------
 * `createEvidence()` pushes the row into the in-memory array and queues the
 * INSERT through `persist()` (fire-and-forget). The refresh loop
 * (`ONETEAM_REFRESH_MS`, default 1000ms) replaces the whole array with a
 * Postgres snapshot. The `pendingWrites > 0` check at the START of
 * `refreshIfChanged()` cannot see a write that begins while `loadAll` is
 * already running — so the snapshot can come back without the row that a 201
 * just acknowledged, the row vanishes from memory, and a read milliseconds
 * later answers 404 until the next poll.
 *
 * Observed in the live tier as the roles flake: `POST /field/submissions`
 * 201, then `GET /api/portal/submissions` misses the id and
 * `POST .../review` answers `404 NOT_FOUND: Audit qeydi tapılmadı`.
 *
 * The guard is therefore re-checked AFTER the snapshot returns: if a local
 * write started during the load, keep the current arrays and let the next
 * tick retry (the write's own version bump makes the next tick reload).
 *
 * Runs in-process against the live PostgreSQL (same DATABASE_URL the harness
 * exports for the API). No API process is needed — this exercises `db`
 * directly. The `db` pool is wrapped in a Proxy so the mid-refresh write is
 * deterministic instead of timing-dependent: the first snapshot query trips
 * `pendingWrites` before `loadAll` returns.
 */
import 'reflect-metadata';
import { db } from '@oneteam/database';

let pass = 0;
let fail = 0;

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

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required: this suite drives db.refreshIfChanged() against\n' +
        '       the real database, which is where the race lives.',
    );
  }

  console.log('\n=== refresh defers while a local write is pending ===');
  await db.init();
  db.stopRefreshLoop();
  db.stopBotSessionSweep();

  // First poll adopts the baseline version (returns false without reloading),
  // so the reload path below is taken for exactly one reason: we force it.
  await db.refreshIfChanged();

  const anyDb = db as any;
  const refreshesBefore = anyDb.refreshCount;
  const writesBefore = anyDb.pendingWrites;
  const realPool = anyDb.pool;
  let reloaded: unknown;
  let bumped = 0;

  try {
    // Wrap the pool `refreshIfChanged` will hand to readDataVersion/loadAll:
    // the first non-`data_version` query is the snapshot being taken, and that
    // is where a local write starting mid-refresh must be simulated. Patching
    // the pool instead of the module sidesteps tsx's getter-only namespaces
    // and the src-vs-dist copy of the database package.
    anyDb.pool = new Proxy(realPool, {
      get(target: any, prop: string) {
        const value = target[prop];
        if ((prop === 'query' || prop === 'connect') && typeof value === 'function') {
          return (...args: unknown[]) => {
            const sql = typeof args[0] === 'string' ? args[0] : '';
            if (bumped === 0 && !sql.includes('data_version')) {
              bumped += 1;
              anyDb.pendingWrites += 1;
            }
            return value.apply(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    // Force the reload path: observed version differs from whatever the
    // database reports.
    anyDb.observedVersion = -1;

    reloaded = await db.refreshIfChanged();

    check('refresh returns false instead of swapping mid-write', reloaded === false, {
      reloaded,
      refreshesBefore,
      refreshesAfter: anyDb.refreshCount,
    });
    check('no reload was counted', anyDb.refreshCount === refreshesBefore, {
      before: refreshesBefore,
      after: anyDb.refreshCount,
    });
  } finally {
    anyDb.pool = realPool;
    anyDb.pendingWrites = writesBefore;
    // Leave clean state: null adopts the true current version on next poll,
    // then close.
    anyDb.observedVersion = null;
    await db.refreshIfChanged();
    await db.close();
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(
    `\n❌ Refresh defer suite failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
