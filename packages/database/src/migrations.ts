/**
 * oneTeam — schema migrations and conformance checking
 * ============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The API gained a `mobile_device_id` column, a migration file was written for
 * it, and the column was still absent from every database the code actually
 * ran against. The bind endpoint reported success, the user existed in memory,
 * and `upsertDeviceUser` failed in a log line nobody was reading:
 *
 *     ⛔ [oneTeam DB] Failed to persist user usr-dev-...:
 *        column "mobile_device_id" of relation "users" does not exist
 *
 * A migration that only exists as a file is not applied; it is a wish. The
 * person who can apply it is the operator, and the operator does not use psql.
 * So the schema is applied by the process that needs it, at the moment it
 * starts, and the result is reported where the operator already looks
 * (`/api/health`) instead of into a log stream.
 *
 * HOW IT WORKS
 * ------------
 * Two sources, applied in order, each recorded in `schema_migrations`:
 *
 *   1. `db/api-schema.sql` — the baseline. Every statement in it is guarded
 *      with IF NOT EXISTS, so applying it to a database that already has the
 *      tables is a no-op. That property is what makes it safe to run on every
 *      boot, and it is why the baseline does not need to be special-cased out
 *      once it has been applied once.
 *   2. every `*.sql` in `db/migrations/`, ordered by filename.
 *
 * The whole run holds a PostgreSQL advisory lock on a dedicated connection, so
 * two replicas starting at the same moment cannot both apply migration 3. Each
 * migration runs inside a transaction — PostgreSQL has transactional DDL, so a
 * migration that fails halfway leaves nothing behind.
 *
 * A checksum is recorded per migration. Editing a migration that has already
 * been applied is reported as a problem rather than ignored, because the two
 * databases that were migrated from different versions of the file will not
 * agree and nothing else would say so.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not drop or rename anything. A database carrying a *conflicting*
 * `stores` table — one with different columns, from the Supabase-era schema —
 * cannot be repaired by `CREATE TABLE IF NOT EXISTS`, which will simply skip
 * it. Detecting that and telling a human is the correct behaviour; guessing
 * that a production table is disposable is not. `checkSchema()` is what
 * detects it, and it is the reason the two functions are separate.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join, resolve } from 'path';
import type { Pool, PoolClient } from 'pg';

/**
 * Advisory lock key for the migration run.
 *
 * An arbitrary but fixed number: it only has to be the same in every process
 * that might migrate this database, and must not collide with any other lock
 * this application takes.
 */
const MIGRATION_LOCK_KEY = 727301001;

/** Where the migration files live, relative to the repository root. */
const BASELINE_FILE = join('db', 'api-schema.sql');
const MIGRATIONS_DIR = join('db', 'migrations');

export interface MigrationReport {
  /** Migration ids applied by this run. */
  applied: string[];
  /** Migration ids already recorded and therefore not re-run. */
  alreadyApplied: string[];
  /** Migration ids whose recorded checksum no longer matches the file. */
  edited: string[];
  /** Non-fatal failures, in the order they were found. */
  problems: string[];
  /** Resolved repository root, or null when the SQL files could not be found. */
  rootDir: string | null;
}

export interface SchemaReport {
  ok: boolean;
  /** Tables the repository queries that do not exist at all. */
  missingTables: string[];
  /** `table.column` entries the repository queries that do not exist. */
  missingColumns: string[];
  /** How many table/column pairs were checked. */
  checked: number;
}

/**
 * The shape the repository layer actually queries.
 *
 * Transcribed from the SQL in `postgres.ts` rather than from a schema dump, on
 * purpose: the question this answers is not "does the database match its
 * declared schema" but "will the queries in this process succeed". A column
 * that exists in a schema file and not in the database is exactly the failure
 * this is here to catch.
 */
export const EXPECTED_SCHEMA: Record<string, string[]> = {
  users: [
    'id',
    'email',
    'full_name',
    'role',
    'telegram_chat_id',
    'mobile_device_id',
    'phone',
    'created_at',
    'updated_at',
  ],
  regions: ['id', 'name', 'code', 'created_at', 'updated_at'],
  stores: [
    'id',
    'store_code',
    'name',
    'region_id',
    'chain_name',
    'store_format',
    'address',
    'city',
    'latitude',
    'longitude',
    'is_active',
    'created_at',
    'updated_at',
  ],
  campaigns: [
    'id',
    'name',
    'description',
    'start_date',
    'end_date',
    'is_active',
    'created_at',
    'updated_at',
  ],
  task_templates: [
    'id',
    'campaign_id',
    'title',
    'description',
    'reference_image_url',
    'priority',
    'planogram_rules',
    'requires_before_after_photo',
    'checklist_schema',
    'created_at',
    'updated_at',
  ],
  store_tasks: [
    'id',
    'template_id',
    'store_id',
    'assigned_user_id',
    'status',
    'deadline',
    'published_at',
    'delivered_at',
    'acknowledged_at',
    'submitted_at',
    'reviewed_at',
    'created_at',
    'updated_at',
  ],
  task_evidences: [
    'id',
    'store_task_id',
    'submitted_by_id',
    'photo_url',
    'photo_type',
    'checklist_answers',
    'latitude',
    'longitude',
    'gps_distance_meters',
    'ai_score',
    'ai_detections',
    'ai_summary',
    'reviewer_feedback',
    'submitted_at',
    'created_at',
    'updated_at',
  ],
  audit_logs: [
    'id',
    'entity_type',
    'entity_id',
    'action',
    'from_state',
    'to_state',
    'actor_id',
    'payload',
    'created_at',
  ],
  device_tokens: [
    'token_hash',
    'user_id',
    'device_id',
    'label',
    'created_at',
    'last_seen_at',
    'revoked_at',
  ],
  // Checked like any other table, because a missing `data_version` does not
  // announce itself: the refresh loop reads it, gets nothing, and reports no
  // change forever. A replica would stay silently stale, which is the exact
  // failure the table exists to prevent.
  data_version: ['id', 'version', 'updated_at'],
  // Checked for the same reason as `data_version`, from the other direction: a
  // missing `panel_tokens` makes the panel report "no keys exist", which is
  // read as "the login screen is not needed yet" — so the panel would stay open
  // to anyone and nothing would say why.
  panel_tokens: [
    'token_hash',
    'user_id',
    'label',
    'created_by',
    'created_at',
    'last_seen_at',
    'revoked_at',
  ],
  // Checked for the same reason as the two above: a missing `bot_sessions` does
  // not announce itself either. The bot reads it, gets an error, and tells the
  // merchandiser their work could not be loaded — which is at least honest — but
  // the *cause* would be invisible from the outside, and every audit in the
  // field would fail at the first button tap with nothing in the logs saying
  // why the table is not there.
  bot_sessions: [
    'chat_id',
    'user_id',
    'step',
    'store_id',
    'store_code',
    'store_name',
    'active_task_id',
    'active_task_title',
    'latitude',
    'longitude',
    'checklist_questions',
    'checklist_answers',
    'checklist_index',
    'pending_photo',
    'updated_at',
    'expires_at',
  ],
  // Checked for the same reason as the three above, and one more of its own:
  // a missing `notifications` does not announce itself either. The API would
  // record the intent to notify and fail on the INSERT, and the supervisor
  // creating a task would see a 500 for a reason that has nothing to do with
  // what they did. Worse, if only *some* columns were missing, the insert could
  // succeed while the bot's drain query failed — and the merchandiser would
  // simply never be told, with the row sitting there looking delivered.
  notifications: [
    'id',
    'kind',
    'chat_id',
    'user_id',
    'store_task_id',
    'title',
    'body',
    'payload',
    'dedupe_key',
    'created_at',
    'claimed_at',
    'claimed_by',
    'delivered_at',
    'failed_at',
    'failure',
    'attempts',
  ],
};

/**
 * Walks up from the compiled file's directory looking for the repository root.
 *
 * A search rather than a fixed `../../..` because the depth differs between the
 * two places this code runs — `packages/database/dist/` in development and the
 * same path inside the container — and a hardcoded relative path would break
 * silently the day either layout changes. Returning null rather than throwing
 * is deliberate: a missing SQL directory must degrade to "migrations were not
 * applied, and the health endpoint says so", not to a process that will not
 * start.
 */
function findRepoRoot(startDir: string): string | null {
  let dir = startDir;
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, BASELINE_FILE))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

interface MigrationFile {
  id: string;
  path: string;
  sql: string;
  checksum: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Checksum of a migration's *statements*, ignoring how they are commented.
 *
 * Hashing the raw file means a typo fixed in a comment is reported as "this
 * migration has been edited after it was applied", which is alarming, is not
 * true in any way that matters, and — because it would fire often — would train
 * the reader to ignore the one case where it is real. So whole-line comments
 * and blank lines are removed before hashing.
 *
 * Only comments that occupy a line of their own are stripped. A `--` inside a
 * statement is left alone, because it may be inside a string literal, and
 * guessing wrong there would hide a genuine change — the opposite failure and a
 * much worse one.
 */
function checksumOf(sql: string): string {
  const statements = sql
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('--');
    })
    .join('\n')
    .trim();

  return sha256(statements);
}

/**
 * Collects the migrations to apply, in the order they must be applied.
 *
 * The baseline is first and its id is fixed rather than derived from a
 * filename, because it is not in the migrations directory — it is the schema
 * the migrations build on.
 */
function collectMigrations(rootDir: string, problems: string[]): MigrationFile[] {
  const files: MigrationFile[] = [];

  const baselinePath = join(rootDir, BASELINE_FILE);
  if (existsSync(baselinePath)) {
    const sql = readFileSync(baselinePath, 'utf8');
    files.push({ id: '0001_base_schema', path: baselinePath, sql, checksum: checksumOf(sql) });
  } else {
    problems.push(`Baseline schema not found at ${baselinePath}`);
  }

  const migrationsDir = join(rootDir, MIGRATIONS_DIR);
  if (!existsSync(migrationsDir)) {
    problems.push(`Migrations directory not found at ${migrationsDir}`);
    return files;
  }

  const names = readdirSync(migrationsDir)
    .filter((name) => name.toLowerCase().endsWith('.sql'))
    .sort();

  for (const name of names) {
    const path = join(migrationsDir, name);
    const sql = readFileSync(path, 'utf8');
    files.push({ id: name.replace(/\.sql$/i, ''), path, sql, checksum: checksumOf(sql) });
  }

  return files;
}

/**
 * Applies pending migrations. Safe to call concurrently and safe to re-run.
 *
 * Every failure is collected rather than thrown. The caller is the API's
 * start-up path, and a schema problem must not stop the process: an API that
 * runs on seed data and says so is far more useful than one that refuses to
 * boot, and the alternative — swallowing the failure — is what produced this
 * file in the first place.
 */
export async function runMigrations(pool: Pool): Promise<MigrationReport> {
  const report: MigrationReport = {
    applied: [],
    alreadyApplied: [],
    edited: [],
    problems: [],
    rootDir: null,
  };

  const rootDir = findRepoRoot(__dirname);
  report.rootDir = rootDir;
  if (!rootDir) {
    report.problems.push(
      'Could not locate the repository root (no db/api-schema.sql found above ' +
        `${__dirname}). Migrations were NOT applied.`,
    );
    return report;
  }

  const migrations = collectMigrations(rootDir, report.problems);
  if (migrations.length === 0) return report;

  // One connection for the whole run, because an advisory lock belongs to a
  // session and `pool.query` is free to use a different connection each time —
  // which would take the lock on one and release it on another.
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    report.problems.push('Could not acquire a connection to run migrations: ' + describe(error));
    return report;
  }

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id         TEXT PRIMARY KEY,
         checksum   TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );

    const recorded = await client.query('SELECT id, checksum FROM schema_migrations');
    const known = new Map<string, string>(
      recorded.rows.map((row) => [row.id as string, row.checksum as string]),
    );

    for (const migration of migrations) {
      const previousChecksum = known.get(migration.id);

      if (previousChecksum !== undefined) {
        report.alreadyApplied.push(migration.id);
        if (previousChecksum !== migration.checksum) {
          report.edited.push(migration.id);
        }
        continue;
      }

      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [
          migration.id,
          migration.checksum,
        ]);
        await client.query('COMMIT');
        report.applied.push(migration.id);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        report.problems.push(
          `Migration ${migration.id} failed and was rolled back: ${describe(error)}`,
        );
        // Later migrations build on this one, so continuing would produce a
        // cascade of confusing failures on top of the real one.
        break;
      }
    }
  } catch (error) {
    report.problems.push('Migration run aborted: ' + describe(error));
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }

  return report;
}

/**
 * Checks that every table and column the repository queries actually exists.
 *
 * This is the part that turns a silent wrong-shape database into a sentence.
 * `CREATE TABLE IF NOT EXISTS` cannot detect a pre-existing table with
 * different columns — it skips it and reports success — so after any schema
 * change the honest question is not "did the migration run" but "do the
 * queries this process is about to issue resolve".
 */
export async function checkSchema(pool: Pool): Promise<SchemaReport> {
  const tables = Object.keys(EXPECTED_SCHEMA);

  const result = await pool.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
    [tables],
  );

  const found = new Map<string, Set<string>>();
  for (const row of result.rows) {
    const table = row.table_name as string;
    if (!found.has(table)) found.set(table, new Set());
    found.get(table)!.add(row.column_name as string);
  }

  const missingTables: string[] = [];
  const missingColumns: string[] = [];
  let checked = 0;

  for (const [table, columns] of Object.entries(EXPECTED_SCHEMA)) {
    const present = found.get(table);
    if (!present) {
      missingTables.push(table);
      continue;
    }
    for (const column of columns) {
      checked++;
      if (!present.has(column)) missingColumns.push(`${table}.${column}`);
    }
  }

  return {
    ok: missingTables.length === 0 && missingColumns.length === 0,
    missingTables,
    missingColumns,
    checked,
  };
}

/**
 * One line a human can act on, built from the two reports.
 *
 * Kept next to the checks rather than in the controller so that the wording
 * and the detection cannot drift apart.
 */
export function describeSchemaHealth(
  migrations: MigrationReport | null,
  schema: SchemaReport | null,
): { ok: boolean; detail: string } {
  if (!migrations && !schema) {
    return { ok: false, detail: 'schema was never checked (no database connection)' };
  }

  const parts: string[] = [];

  if (migrations) {
    parts.push(
      migrations.applied.length
        ? `applied ${migrations.applied.join(', ')}`
        : 'no pending migrations',
    );
  }
  if (schema) {
    parts.push(schema.ok ? `${schema.checked} columns verified` : 'schema mismatch');
  }

  const problems = [
    ...(migrations?.problems ?? []),
    ...(migrations?.edited ?? []).map(
      (id) =>
        `Migration ${id} has been edited after it was applied. The database was ` +
        'migrated from an older version of that file — add a new migration instead of editing one.',
    ),
    ...(schema?.missingTables ?? []).map((table) => `Table is missing: ${table}`),
    ...(schema?.missingColumns ?? []).map((column) => `Column is missing: ${column}`),
  ];

  if (problems.length > 0) {
    return { ok: false, detail: parts.join('; ') + ' — ' + problems.join(' | ') };
  }

  return { ok: true, detail: parts.join('; ') };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
