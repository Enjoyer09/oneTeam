/**
 * oneTeam — cross-replica convergence suite
 * ============================================================================
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Reads come from in-memory arrays hydrated once at start-up. For a single
 * process that is correct and fast. For two, it is silently wrong: replica B
 * never learns about anything replica A wrote, does not fail, does not log, and
 * reports a healthy status while answering with data that is arbitrarily old.
 *
 * HOW THIS TEST SIMULATES A SECOND REPLICA
 * -----------------------------------------
 * It writes a row straight into PostgreSQL, with `pg`, completely bypassing the
 * application. That is exactly what another replica's write looks like from the
 * perspective of the process under test: a change in the shared database that
 * this process did not make and was not told about.
 *
 * It then asserts BOTH directions, and the second is the one that matters:
 *
 *   1. The change is NOT yet visible immediately after it is committed. This is
 *      the honest statement of the limitation, and asserting it is what stops
 *      this suite from passing against an application that reloads on every
 *      read (which would be correct but not the thing being built).
 *   2. It IS visible after the polling interval. This is the fix.
 *
 * A suite that only checked (2) would pass against a process that happened to
 * reload for an unrelated reason, and would say nothing about whether the
 * mechanism works.
 *
 * Prerequisites: the API must be running with a refresh interval, and
 * DATABASE_URL must point at the same database.
 *
 *   ONETEAM_REFRESH_MS=1000 npm run api:dev
 *   DATABASE_URL=postgres://... ONETEAM_API_URL=http://localhost:3001 npm run test:replica
 */

import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

const API_BASE = (process.env.ONETEAM_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || '';
const SERVICE_TOKEN = process.env.ONETEAM_TEST_SERVICE_TOKEN || 'oneteam-user:usr-merch-003';
const STORE_ID = process.env.ONETEAM_TEST_STORE_ID || 'str-bravo-yasamal';

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

async function api(path: string, token?: string): Promise<any> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/** The task ids this process can currently see for the store. */
async function visibleTaskIds(): Promise<string[]> {
  const payload = await api(
    `/api/portal/field/tasks?storeId=${encodeURIComponent(STORE_ID)}`,
    SERVICE_TOKEN,
  );
  const rows = payload?.data ?? [];
  return rows.map((row: any) => row.id);
}

async function main(): Promise<void> {
  console.log(`\n=== cross-replica convergence against ${API_BASE} ===`);

  if (!DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required: this suite writes a row directly, which is the\n' +
        '       only way to simulate a second replica.',
    );
  }

  const health = await api('/api/health');
  const sync = health?.replicaSync;
  const intervalMs: number = sync?.intervalMs ?? 0;

  console.log(`  \u2139 refresh interval: ${intervalMs}ms — ${sync?.detail}`);
  if (health?.persistence !== 'postgres') {
    throw new Error(
      `The API is not on postgres (persistence: ${health?.persistence}).\n` +
        '       There is nothing to converge to.',
    );
  }

  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();

  const taskId = `task-replica-sync-${randomUUID().slice(0, 8)}`;
  let created = false;

  try {
    const before = await visibleTaskIds();
    const versionBefore = await readVersion(db);
    const reloadsBefore: number = sync?.reloadsSinceStart ?? 0;

    console.log('\nthe change counter');
    check(
      'the counter exists and reads as a number',
      typeof versionBefore === 'number',
      versionBefore,
    );

    // ---------------------------------------------------------------------
    // A write made outside this process — i.e. by another replica.
    // ---------------------------------------------------------------------
    await db.query(
      `INSERT INTO store_tasks (id, template_id, store_id, status, deadline, created_at, updated_at)
       VALUES ($1, 'tmpl-cooler-check', $2, 'PUBLISHED', now() + interval '7 days', now(), now())`,
      [taskId, STORE_ID],
    );
    created = true;

    const versionAfter = await readVersion(db);
    check(
      'a trigger bumped the counter on an external write',
      typeof versionAfter === 'number' &&
        typeof versionBefore === 'number' &&
        versionAfter > versionBefore,
      { before: versionBefore, after: versionAfter },
    );

    // ---------------------------------------------------------------------
    // 1. The staleness is real — this is the limitation, stated rather than
    //    papered over.
    // ---------------------------------------------------------------------
    console.log('\nthe staleness window, before it is closed');

    const immediately = await visibleTaskIds();
    if (!sync?.enabled) {
      skip(
        'the external write is not yet visible',
        'replica sync is disabled (ONETEAM_REFRESH_MS=0) — the process has no way to notice',
      );
      skip('the external write becomes visible after the interval', 'replica sync is disabled');
    } else if (intervalMs < 1000) {
      // With a very short interval the poll can land between the insert and the
      // read, which would make the assertion flaky rather than wrong. Not
      // asserting it is better than asserting something that is not reliably
      // observable.
      skip(
        'the external write is not yet visible',
        `the interval (${intervalMs}ms) is too short to observe the window reliably`,
      );
    } else {
      check(
        'the external write is not yet visible (the limitation is real)',
        !immediately.includes(taskId),
        immediately,
      );
    }

    // ---------------------------------------------------------------------
    // 2. The fix — it converges without anyone restarting anything.
    // ---------------------------------------------------------------------
    if (sync?.enabled) {
      console.log('\nconvergence');

      // Two intervals plus a generous margin for the reload query itself.
      const waitMs = intervalMs * 2 + 1500;
      await new Promise((resolve) => setTimeout(resolve, waitMs));

      const after = await visibleTaskIds();
      check(
        `the external write is visible after ~${waitMs}ms (one interval plus reload)`,
        after.includes(taskId),
        { waiting: waitMs, visible: after.length, expected: taskId },
      );

      const healthAfter = await api('/api/health');
      check(
        'the process recorded a reload',
        (healthAfter?.replicaSync?.reloadsSinceStart ?? 0) > reloadsBefore,
        {
          before: reloadsBefore,
          after: healthAfter?.replicaSync?.reloadsSinceStart,
        },
      );
      check(
        'the process reports when it last reloaded',
        typeof healthAfter?.replicaSync?.lastReloadAt === 'string',
        healthAfter?.replicaSync?.lastReloadAt,
      );
      check(
        'health states the worst-case staleness',
        healthAfter?.replicaSync?.worstCaseStalenessMs === intervalMs,
        healthAfter?.replicaSync?.worstCaseStalenessMs,
      );
      check(
        'the visible task count grew by the one row that was added',
        after.length === before.length + 1,
        { before: before.length, after: after.length },
      );
    } else {
      skip('the process converges on the external write', 'replica sync is disabled');
    }

    // ---------------------------------------------------------------------
    // A deletion has to propagate too. An insert-only check would pass against
    // a mechanism that only ever adds.
    // ---------------------------------------------------------------------
    if (sync?.enabled && intervalMs >= 1000) {
      console.log('\ndeletions propagate too');
      await db.query('DELETE FROM store_tasks WHERE id = $1', [taskId]);
      created = false;

      await new Promise((resolve) => setTimeout(resolve, intervalMs * 2 + 1500));
      const afterDelete = await visibleTaskIds();
      check(
        'the deleted row is gone from the process view',
        !afterDelete.includes(taskId),
        afterDelete,
      );
    }
  } finally {
    // Leave the database as it was found. A test that litters is a test that
    // eventually changes the behaviour of something else.
    if (created) {
      await db.query('DELETE FROM store_tasks WHERE id = $1', [taskId]).catch(() => undefined);
    }
    await db.end();
  }

  console.log(`\n=== ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''} ===\n`);
  if (skipped) {
    console.log('  A skip means the assertion could not run, not that it held.\n');
  }
  process.exit(fail === 0 ? 0 : 1);
}

async function readVersion(db: Client): Promise<number | null> {
  try {
    const result = await db.query('SELECT version FROM data_version WHERE id = TRUE');
    const value = result.rows[0]?.version;
    return value === undefined || value === null ? null : Number(value);
  } catch {
    return null;
  }
}

main().catch((error) => {
  console.error(
    `\n\u274C Replica sync suite failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
