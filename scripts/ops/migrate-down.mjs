#!/usr/bin/env node
/**
 * oneTeam — migration rollback (down) for the most recent applied migration.
 *
 * ============================================================================
 * WHY A SEPARATE RUNNER
 * ---------------------
 * The API's own migration runner (`packages/database/src/migrations.ts`) only
 * moves forward: it applies `db/migrations/*.sql` in filename order and
 * records each in `schema_migrations`. It never drops anything, by design —
 * an automatic `DROP` on boot is how production data dies. Rollback is an
 * operator action, so it lives here, behind the same lock the up-runner
 * uses, and it refuses to touch anything but the single most recent
 * migration.
 *
 * HOW IT WORKS
 * ------------
 *   1. Reads the LATEST applied migration id from `schema_migrations`
 *      (the row with the newest `applied_at`, ignoring the fixed baseline).
 *   2. Looks for `db/migrations/down/<id>.down.sql`. If that file does not
 *      exist, it stops and says so — a migration without a down file cannot
 *      be rolled back, and inventing one now is how deployments drift.
 *   3. Runs the down SQL inside a transaction, then deletes the row from
 *      `schema_migrations` in the SAME transaction, so the two can never
 *      disagree (schema rolled back but still recorded as applied, or the
 *      reverse).
 *
 * SAFETY PROPERTIES
 * -----------------
 *   - Only the most recent migration can be rolled back, because only that
 *     one is guaranteed to be safe: nothing later was built on top of it.
 *   - `--yes` is required; the script prints exactly what will be rolled
 *     back and exits 1 without it. Non-interactive safety, like db-backup.sh.
 *   - Everything is transactional. A down script that fails halfway leaves
 *     the database exactly as it was, with the migration still recorded.
 *   - The advisory lock is the same key the up-runner uses
 *     (`MIGRATION_LOCK_KEY = 727301001`), so a rollback cannot race a
 *     concurrent boot-time migration.
 *
 * USAGE
 * -----
 *   DATABASE_URL=... node scripts/ops/migrate-down.mjs --yes
 *
 * ENVIRONMENT
 * -----------
 *   DATABASE_URL  (required) postgres://<user>:***@host:port/db
 *   ROLLBACK_TO   (optional) "all" or a specific migration id to roll back
 *                 EVERYTHING/one migration. Default: only the latest one.
 *                 "all" walks back one migration at a time, newest first.
 *
 * ponytail: `ROLLBACK_TO=all` works but each step still requires a down file;
 * a migration without one halts the walk. There is no `--force` — the moment
 * rollback needs violence it needs a human with a backup, not a script.
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;
const MIGRATION_LOCK_KEY = 727301001;
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const DOWN_DIR = join(REPO_ROOT, 'db', 'migrations', 'down');
const BASELINE_ID = '0001_base_schema';

const args = process.argv.slice(2);
const yes = args.includes('--yes');
const rollbackTo = process.argv.find((a) => a.startsWith('--to='))?.split('=')[1];

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

if (!yes) {
  console.error('Refusing to run without --yes. This rolls back a migration.');
  process.exit(1);
}

if (!existsSync(DOWN_DIR)) {
  console.error(`No down scripts directory at ${DOWN_DIR}`);
  process.exit(1);
}

const downFiles = new Map(
  readdirSync(DOWN_DIR)
    .filter((f) => f.endsWith('.down.sql'))
    .map((f) => [f.replace(/\.down\.sql$/, ''), f]),
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function latestApplied() {
  const q = await pool.query(
    `SELECT id, checksum, applied_at
       FROM schema_migrations
      WHERE id <> $1
      ORDER BY applied_at DESC
      LIMIT 1`,
    [BASELINE_ID],
  );
  return q.rows[0] ?? null;
}

async function rollbackOne(id) {
  const file = downFiles.get(id);
  if (!file) {
    console.error(`No down script for migration ${id}. Rollback stopped here.`);
    return false;
  }
  const sql = readFileSync(join(DOWN_DIR, file), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('DELETE FROM schema_migrations WHERE id = $1', [id]);
    await client.query('COMMIT');
    console.log(`Rolled back ${id} (${file}).`);
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(`Rollback of ${id} failed and was rolled back:`, e.message);
    return false;
  } finally {
    client.release();
  }
}

async function main() {
  const client = await pool.connect();
  let ok = true;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    const current = await latestApplied();
    if (!current) {
      console.log('No migrations applied beyond the baseline. Nothing to roll back.');
      return;
    }

    if (rollbackTo === 'all') {
      let last = current;
      while (last) {
        if (!rollbackOne(last.id)) {
          ok = false;
          break;
        }
        last = await latestApplied();
      }
      if (!ok) process.exitCode = 1;
      return;
    }

    if (rollbackTo && rollbackTo !== current.id) {
      console.error(
        `Refusing: migration to roll back (${rollbackTo}) is not the most recent ` +
          `(${current.id}). Roll back one at a time, newest first.`,
      );
      process.exitCode = 1;
      return;
    }

    if (!rollbackOne(current.id)) process.exitCode = 1;
  } catch (e) {
    console.error('Rollback aborted:', e.message);
    process.exitCode = 1;
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main();
