/**
 * oneTeam — PostgreSQL persistence for the API
 * ============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The API shipped with a complete in-memory repository (`EnterpriseDatabase`)
 * and a fully provisioned PostgreSQL instance that nothing ever queried. Every
 * task, evidence and audit entry lived in a JavaScript array and was lost on
 * each restart — including every redeploy, and Railway redeploys on every push
 * to main.
 *
 * WHY `pg` AND NOT PRISMA
 * -----------------------
 * The repository declared Prisma (`schema.prisma`, a `db:generate` script, and
 * `@prisma/client` as a dependency), so Prisma was the obvious first choice.
 * It is not usable in this project as it stands:
 *
 *   - `prisma generate` does not exist. The installed CLI is 8.0.0-rc.13, a
 *     release candidate, and answers `CLI.UNKNOWN_COMMAND: No command
 *     registered for 'generate'`.
 *   - The CLI (8.0.0-rc.13) and the client (7.10.0) are different major
 *     versions, which Prisma requires to match.
 *   - No client has ever been generated: node_modules/.prisma does not exist.
 *
 * `pg` is a single, stable, build-free dependency with no code-generation step,
 * which also removes a whole class of build-time failure from the deploy
 * pipeline. schema.prisma is left in the repository as the model of record.
 *
 * HOW IT IS USED
 * --------------
 * The read path stays in memory, because the API's services call the repository
 * synchronously in about thirty places and making all of them async would be a
 * large, risky change for no functional gain at this scale.
 *
 * The database is therefore authoritative at two moments:
 *
 *   - on start-up, `loadAll()` hydrates the in-memory arrays from PostgreSQL,
 *     so a restart or redeploy resumes from persisted state rather than from
 *     the seed constants;
 *   - on every mutation, the write-through helpers below persist the change.
 *
 * The honest limitation: this is a single-instance design. Two replicas would
 * each hold their own copy and only agree after a restart. The API runs as one
 * instance, and the alternative — an async rewrite — is a separate piece of
 * work rather than a prerequisite for using the database at all.
 */

import { Pool } from 'pg';
import type { TaskState } from '@oneteam/types';
import type { InMemoryStoreTask, InMemoryEvidence, InMemoryAuditLog, InMemoryStore } from './types';

/** Everything the in-memory repository needs to start from real data. */
export interface HydratedState {
  users: any[];
  region: any;
  stores: InMemoryStore[];
  campaign: any;
  templates: any[];
  storeTasks: InMemoryStoreTask[];
  evidences: InMemoryEvidence[];
  auditLogs: InMemoryAuditLog[];
}

/**
 * Builds a connection pool.
 *
 * No `ssl` option is set, deliberately. `DATABASE_URL` points at Railway's
 * private network (`postgres.railway.internal`), which is a plain TCP path
 * inside the project and does not offer a certificate a client could verify;
 * asking for TLS there fails the handshake. A managed Postgres reached over the
 * public internet would need `ssl: { rejectUnauthorized: false }`, and that
 * belongs in configuration rather than hardcoded here.
 */
export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    // 5s, not 10s, because this value multiplies the start-up retry loop in
    // EnterpriseDatabase.init(): 10 attempts x (5s connect + 3s delay) is an
    // 80-second worst case, which still fits inside the container healthcheck's
    // grace period. At 10s it would not.
    connectionTimeoutMillis: 5_000,
  });
}

const asDate = (value: unknown): Date | undefined =>
  value === null || value === undefined ? undefined : new Date(value as string);

const asRequiredDate = (value: unknown): Date => new Date(value as string);

// ---------------------------------------------------------------------------
// Row mapping (snake_case columns -> the camelCase shapes the API already uses)
// ---------------------------------------------------------------------------

function toStoreTask(row: any): InMemoryStoreTask {
  return {
    id: row.id,
    templateId: row.template_id,
    storeId: row.store_id,
    assignedUserId: row.assigned_user_id ?? undefined,
    status: row.status as TaskState,
    deadline: asRequiredDate(row.deadline),
    publishedAt: asDate(row.published_at),
    deliveredAt: asDate(row.delivered_at),
    acknowledgedAt: asDate(row.acknowledged_at),
    submittedAt: asDate(row.submitted_at),
    reviewedAt: asDate(row.reviewed_at),
    createdAt: asRequiredDate(row.created_at),
    updatedAt: asRequiredDate(row.updated_at),
  };
}

function toEvidence(row: any): InMemoryEvidence {
  return {
    id: row.id,
    storeTaskId: row.store_task_id,
    submittedById: row.submitted_by_id,
    photoUrl: row.photo_url,
    photoType: row.photo_type,
    checklistAnswers: row.checklist_answers ?? [],
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    gpsDistanceMeters: Number(row.gps_distance_meters),
    aiScore: row.ai_score,
    aiDetections: row.ai_detections ?? [],
    aiSummary: row.ai_summary,
    reviewerFeedback: row.reviewer_feedback ?? undefined,
    submittedAt: asRequiredDate(row.submitted_at),
    createdAt: asRequiredDate(row.created_at),
    updatedAt: asRequiredDate(row.updated_at),
  };
}

function toAuditLog(row: any): InMemoryAuditLog {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    fromState: row.from_state ?? undefined,
    toState: row.to_state ?? undefined,
    actorId: row.actor_id ?? undefined,
    payload: row.payload ?? undefined,
    createdAt: asRequiredDate(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Loads the entire working set.
 *
 * The tables are small (three users, three stores, a handful of tasks), so a
 * full load at start-up is simpler and far more predictable than lazy per-query
 * loading, and it keeps the synchronous read path intact.
 */
export async function loadAll(pool: Pool): Promise<HydratedState> {
  const [users, regions, stores, campaigns, templates, storeTasks, evidences, auditLogs] =
    await Promise.all([
      pool.query('SELECT * FROM users ORDER BY created_at'),
      pool.query('SELECT * FROM regions ORDER BY created_at'),
      pool.query('SELECT * FROM stores ORDER BY store_code'),
      pool.query('SELECT * FROM campaigns ORDER BY created_at'),
      pool.query('SELECT * FROM task_templates ORDER BY created_at'),
      pool.query('SELECT * FROM store_tasks ORDER BY created_at'),
      pool.query('SELECT * FROM task_evidences ORDER BY created_at'),
      pool.query('SELECT * FROM audit_logs ORDER BY created_at'),
    ]);

  return {
    users: users.rows.map((r) => ({
      id: r.id,
      email: r.email,
      fullName: r.full_name,
      role: r.role,
      telegramChatId: r.telegram_chat_id ?? undefined,
      // Both channel keys, and both have to be read back.
      //
      // `mobile_device_id` was added to the write path (`upsertDeviceUser`)
      // and not to this mapping, which produced a bind that persisted
      // correctly and then vanished from the application's view on the next
      // restart: the row was in the database, `getUserByMobileDeviceId`
      // returned null, and the device was told it had never registered.
      // A column that is written but never read is half a feature.
      mobileDeviceId: r.mobile_device_id ?? undefined,
      phone: r.phone ?? undefined,
      createdAt: asRequiredDate(r.created_at),
      updatedAt: asRequiredDate(r.updated_at),
    })),
    region: regions.rows[0]
      ? {
          id: regions.rows[0].id,
          name: regions.rows[0].name,
          code: regions.rows[0].code,
          createdAt: asRequiredDate(regions.rows[0].created_at),
          updatedAt: asRequiredDate(regions.rows[0].updated_at),
        }
      : null,
    stores: stores.rows.map((r) => ({
      id: r.id,
      storeCode: r.store_code,
      name: r.name,
      regionId: r.region_id,
      chainName: r.chain_name,
      storeFormat: r.store_format,
      address: r.address,
      city: r.city,
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      isActive: r.is_active,
      createdAt: asRequiredDate(r.created_at),
      updatedAt: asRequiredDate(r.updated_at),
    })),
    campaign: campaigns.rows[0]
      ? {
          id: campaigns.rows[0].id,
          name: campaigns.rows[0].name,
          description: campaigns.rows[0].description,
          startDate: asRequiredDate(campaigns.rows[0].start_date),
          endDate: asRequiredDate(campaigns.rows[0].end_date),
          isActive: campaigns.rows[0].is_active,
          createdAt: asRequiredDate(campaigns.rows[0].created_at),
          updatedAt: asRequiredDate(campaigns.rows[0].updated_at),
        }
      : null,
    templates: templates.rows.map((r) => ({
      id: r.id,
      campaignId: r.campaign_id,
      title: r.title,
      description: r.description,
      referenceImageUrl: r.reference_image_url,
      priority: r.priority,
      planogramRules: r.planogram_rules ?? [],
      requiresBeforeAfterPhoto: r.requires_before_after_photo,
      checklistSchema: r.checklist_schema ?? [],
      createdAt: asRequiredDate(r.created_at),
      updatedAt: asRequiredDate(r.updated_at),
    })),
    storeTasks: storeTasks.rows.map(toStoreTask),
    evidences: evidences.rows.map(toEvidence),
    auditLogs: auditLogs.rows.map(toAuditLog),
  };
}

// ---------------------------------------------------------------------------
// Write-through
// ---------------------------------------------------------------------------

export async function insertStoreTask(pool: Pool, task: InMemoryStoreTask): Promise<void> {
  await pool.query(
    `INSERT INTO store_tasks
       (id, template_id, store_id, assigned_user_id, status, deadline,
        published_at, delivered_at, acknowledged_at, submitted_at, reviewed_at,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (id) DO NOTHING`,
    [
      task.id,
      task.templateId,
      task.storeId,
      task.assignedUserId ?? null,
      task.status,
      task.deadline,
      task.publishedAt ?? null,
      task.deliveredAt ?? null,
      task.acknowledgedAt ?? null,
      task.submittedAt ?? null,
      task.reviewedAt ?? null,
      task.createdAt,
      task.updatedAt,
    ],
  );
}

export async function insertEvidence(pool: Pool, evidence: InMemoryEvidence): Promise<void> {
  await pool.query(
    `INSERT INTO task_evidences
       (id, store_task_id, submitted_by_id, photo_url, photo_type,
        checklist_answers, latitude, longitude, gps_distance_meters,
        ai_score, ai_detections, ai_summary, reviewer_feedback,
        submitted_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (id) DO NOTHING`,
    [
      evidence.id,
      evidence.storeTaskId,
      evidence.submittedById,
      evidence.photoUrl,
      evidence.photoType ?? 'standard',
      JSON.stringify(evidence.checklistAnswers ?? []),
      evidence.latitude,
      evidence.longitude,
      evidence.gpsDistanceMeters,
      evidence.aiScore ?? null,
      JSON.stringify(evidence.aiDetections ?? []),
      evidence.aiSummary ?? null,
      evidence.reviewerFeedback ?? null,
      evidence.submittedAt,
      evidence.createdAt,
      evidence.updatedAt,
    ],
  );
}

export async function insertAuditLog(pool: Pool, entry: InMemoryAuditLog): Promise<void> {
  await pool.query(
    `INSERT INTO audit_logs
       (id, entity_type, entity_id, action, from_state, to_state, actor_id, payload, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO NOTHING`,
    [
      entry.id,
      entry.entityType,
      entry.entityId,
      entry.action,
      entry.fromState ?? null,
      entry.toState ?? null,
      entry.actorId ?? null,
      entry.payload === undefined ? null : JSON.stringify(entry.payload),
      entry.createdAt,
    ],
  );
}

/**
 * Persists the outcome of a state transition.
 *
 * The timestamp columns are written explicitly rather than derived in SQL,
 * because the value the in-memory copy holds is the one the audit log already
 * recorded; letting the database choose its own would make the two disagree by
 * a few milliseconds for no benefit.
 */
export async function updateStoreTaskRow(pool: Pool, task: InMemoryStoreTask): Promise<void> {
  await pool.query(
    `UPDATE store_tasks
        SET status = $2,
            published_at = $3,
            delivered_at = $4,
            acknowledged_at = $5,
            submitted_at = $6,
            reviewed_at = $7,
            updated_at = $8,
            assigned_user_id = $9
      WHERE id = $1`,
    [
      task.id,
      task.status,
      task.publishedAt ?? null,
      task.deliveredAt ?? null,
      task.acknowledgedAt ?? null,
      task.submittedAt ?? null,
      task.reviewedAt ?? null,
      task.updatedAt,
      task.assignedUserId ?? null,
    ],
  );
}

/**
 * Inserts a task template created from the web panel.
 *
 * The panel authors a briefing (title, description, reference image, priority)
 * and expects it to be dispatched immediately, but the API's bulk dispatch takes
 * an existing `templateId`. Creating the template first and dispatching from it
 * keeps the domain model intact — a store task always points at a template —
 * instead of letting the panel write store_tasks directly.
 *
 * `campaign_id` is nullable in the schema, so a template authored outside a
 * campaign is valid rather than an error.
 */
export async function insertTemplate(
  pool: Pool,
  template: {
    id: string;
    campaignId?: string | null;
    title: string;
    description: string;
    referenceImageUrl: string;
    priority: string;
    planogramRules?: unknown[];
    requiresBeforeAfterPhoto?: boolean;
    checklistSchema?: unknown[];
    createdAt?: Date;
    updatedAt?: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO task_templates
       (id, campaign_id, title, description, reference_image_url, priority,
        planogram_rules, requires_before_after_photo, checklist_schema,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO NOTHING`,
    [
      template.id,
      template.campaignId ?? null,
      template.title,
      template.description,
      template.referenceImageUrl,
      template.priority,
      JSON.stringify(template.planogramRules ?? []),
      template.requiresBeforeAfterPhoto ?? false,
      JSON.stringify(template.checklistSchema ?? []),
      template.createdAt ?? new Date(),
      template.updatedAt ?? new Date(),
    ],
  );
}

/**
 * Inserts a retail point.
 *
 * `store_code` carries its own UNIQUE constraint, so a duplicate code raises a
 * Postgres error rather than quietly creating a second row. That is deliberate
 * and it is the behaviour the API depends on: the service does not pre-check
 * the code with a SELECT, because a check-then-insert has a race window between
 * the two statements, while the constraint has none. The service translates the
 * resulting error into a readable conflict; it does not try to prevent it.
 */
export async function insertStore(pool: Pool, store: InMemoryStore): Promise<void> {
  await pool.query(
    `INSERT INTO stores
       (id, store_code, name, region_id, chain_name, store_format, address, city,
        latitude, longitude, is_active, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      store.id,
      store.storeCode,
      store.name,
      store.regionId,
      store.chainName,
      store.storeFormat,
      store.address,
      store.city,
      store.latitude,
      store.longitude,
      store.isActive,
      store.createdAt ?? new Date(),
      store.updatedAt ?? new Date(),
    ],
  );
}

/**
 * Writes back the editable columns of a store.
 *
 * Every column the panel can change is included, so a single statement covers
 * both "edit the address" and "deactivate this store". `id` and `created_at`
 * are not in the SET list: an edit must not be able to move a store's identity
 * or rewrite when it was created, and leaving them out of the statement is a
 * stronger guarantee than remembering not to pass them.
 *
 * Returns whether a row matched, so the caller can tell "updated" from
 * "no such store" instead of reporting success for a no-op.
 */
export async function updateStoreRow(pool: Pool, store: InMemoryStore): Promise<boolean> {
  const result = await pool.query(
    `UPDATE stores
        SET store_code = $2,
            name = $3,
            region_id = $4,
            chain_name = $5,
            store_format = $6,
            address = $7,
            city = $8,
            latitude = $9,
            longitude = $10,
            is_active = $11,
            updated_at = $12
      WHERE id = $1`,
    [
      store.id,
      store.storeCode,
      store.name,
      store.regionId,
      store.chainName,
      store.storeFormat,
      store.address,
      store.city,
      store.latitude,
      store.longitude,
      store.isActive,
      store.updatedAt ?? new Date(),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Removes a store.
 *
 * `store_tasks.store_id` is `ON DELETE RESTRICT`, so this throws when the store
 * still has work against it. The service counts the tasks first and refuses
 * with a readable conflict; this function is the last line of defence for the
 * race where a task is dispatched between that count and this delete. Returns
 * whether a row was actually removed.
 */
export async function deleteStoreRow(pool: Pool, storeId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM stores WHERE id = $1', [storeId]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * How many store tasks point at a store.
 *
 * Used to refuse a delete before attempting it, so the operator gets "this
 * store has 4 tasks" rather than a foreign-key violation. It is a pre-check and
 * therefore advisory — see `deleteStoreRow` for what happens when the answer
 * goes stale between the two statements.
 */
export async function countStoreTasksForStore(pool: Pool, storeId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM store_tasks WHERE store_id = $1',
    [storeId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Persists a reviewer's decision on an evidence record.
 *
 * Only the review columns are touched. The GPS coordinates, photo URL and
 * checklist answers are the field worker's original submission and must not be
 * rewritten by a reviewer — an audit trail that can be edited by the person
 * auditing it is not an audit trail.
 */
export async function updateEvidenceRow(pool: Pool, evidence: InMemoryEvidence): Promise<void> {
  await pool.query(
    `UPDATE task_evidences
        SET ai_score = $2,
            ai_summary = $3,
            ai_detections = $4,
            reviewer_feedback = $5,
            updated_at = $6
      WHERE id = $1`,
    [
      evidence.id,
      evidence.aiScore ?? null,
      evidence.aiSummary ?? null,
      JSON.stringify(evidence.aiDetections ?? []),
      evidence.reviewerFeedback ?? null,
      evidence.updatedAt,
    ],
  );
}

/**
 * Inserts a user, or attaches a Telegram chat id to the existing row.
 *
 * The bot binds a chat to a user on first contact. Two cases, and they must not
 * be confused: a user the seed already knows (matched by chat id) just gets
 * their name refreshed, while an unknown chat produces a new merchandiser row.
 * Doing this as one `INSERT ... ON CONFLICT` on `id` would miss the second
 * unique constraint — `telegram_chat_id` is also unique — and a chat that
 * already belonged to someone would fail the insert instead of updating them.
 */
export async function upsertTelegramUser(
  pool: Pool,
  user: {
    id: string;
    email: string;
    fullName: string;
    role: string;
    telegramChatId: string;
    phone?: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, full_name, role, telegram_chat_id, phone, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now(), now())
     ON CONFLICT (telegram_chat_id) DO UPDATE
        SET full_name = EXCLUDED.full_name,
            updated_at = now()`,
    [user.id, user.email, user.fullName, user.role, user.telegramChatId, user.phone ?? null],
  );
}

/**
 * Persists a device-bound user, creating the row on first contact.
 *
 * The mirror of `upsertTelegramUser`. Both keys live on the same row because
 * they are two names for the same person, and the anti-fraud rules are written
 * against the person.
 *
 * WHY THE CONFLICT TARGET REPEATS THE INDEX PREDICATE
 * ---------------------------------------------------
 * `mobile_device_id` is covered by a *partial* unique index — unique where the
 * value is not null, so that any number of Telegram-only users can coexist.
 * PostgreSQL will not infer a partial index from a bare column list: the
 * statement below failed at runtime with
 *
 *     there is no unique or exclusion constraint matching the ON CONFLICT
 *     specification
 *
 * because `ON CONFLICT (mobile_device_id)` only matches a *total* unique index.
 * The `WHERE mobile_device_id IS NOT NULL` clause is not decoration — it is how
 * the inference is told which index is meant, and it has to be written exactly
 * as the index was created. Removing it turns every device bind back into a
 * silent, logged-only failure.
 *
 * The same does not apply to `upsertTelegramUser`, whose index on
 * `telegram_chat_id` is a plain unique constraint covering the whole table.
 */
export async function upsertDeviceUser(
  pool: Pool,
  user: {
    id: string;
    email: string;
    fullName: string;
    role: string;
    mobileDeviceId: string;
    phone?: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, full_name, role, mobile_device_id, phone, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now(), now())
     ON CONFLICT (mobile_device_id) WHERE mobile_device_id IS NOT NULL
     DO UPDATE
        SET full_name = EXCLUDED.full_name,
            updated_at = now()`,
    [user.id, user.email, user.fullName, user.role, user.mobileDeviceId, user.phone ?? null],
  );
}

// ---------------------------------------------------------------------------
// Device credentials
// ---------------------------------------------------------------------------
//
// These three are the only helpers in this file whose read path is the database
// rather than the in-memory copy, and deliberately so. A credential has to be
// authoritative: a token that is valid on one replica and not another, or that
// survives a restart in memory but not in the database, is not a credential.
// The tables they touch are not part of `loadAll` — nothing reads a token until
// someone presents one.

/**
 * Revokes any live token for a device and inserts a new one, atomically.
 *
 * Both statements in one transaction because the partial unique index allows
 * exactly one live token per device: inserting before revoking would violate it,
 * and revoking without inserting would lock the device out if the insert then
 * failed.
 */
export async function insertDeviceToken(
  pool: Pool,
  token: {
    tokenHash: string;
    userId: string;
    deviceId: string;
    label?: string | null;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE device_tokens
          SET revoked_at = now()
        WHERE device_id = $1
          AND revoked_at IS NULL`,
      [token.deviceId],
    );
    await client.query(
      `INSERT INTO device_tokens (token_hash, user_id, device_id, label)
       VALUES ($1, $2, $3, $4)`,
      [token.tokenHash, token.userId, token.deviceId, token.label ?? null],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Looks up a live token by its hash.
 *
 * Returns null for a token that is unknown, revoked, or whose user has been
 * deleted — three cases that must all be "not authorised" and none of which
 * should be distinguishable to the caller.
 */
export async function findDeviceToken(
  pool: Pool,
  tokenHash: string,
): Promise<{ userId: string; deviceId: string; lastSeenAt: Date | null } | null> {
  const result = await pool.query(
    `SELECT user_id, device_id, last_seen_at
       FROM device_tokens
      WHERE token_hash = $1
        AND revoked_at IS NULL`,
    [tokenHash],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    userId: row.user_id,
    deviceId: row.device_id,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
  };
}

/** Records that a token was used. Fire-and-forget; throttled by the caller. */
export async function touchDeviceToken(pool: Pool, tokenHash: string): Promise<void> {
  await pool.query('UPDATE device_tokens SET last_seen_at = now() WHERE token_hash = $1', [
    tokenHash,
  ]);
}

/** Cuts a device off. Kept as a timestamp rather than a delete; see the migration. */
export async function revokeDeviceToken(pool: Pool, tokenHash: string): Promise<boolean> {
  const result = await pool.query(
    'UPDATE device_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash],
  );
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Panel credentials
// ---------------------------------------------------------------------------
//
// Same reasoning as the device helpers above: the read path is the database,
// not the in-memory copy, because a credential has to be authoritative. Unlike
// device tokens these are never used by a machine — they belong to a person
// sitting at a browser, and they are the thing that makes `audit_logs` name an
// individual instead of "whichever admin the edge injected".

/**
 * Inserts a panel key.
 *
 * No revoke-then-insert transaction, unlike the device path: there is no unique
 * constraint to satisfy, because a person may hold several live keys at once.
 * See the migration for why that is the intended behaviour.
 */
export async function insertPanelToken(
  pool: Pool,
  token: {
    tokenHash: string;
    userId: string;
    label?: string | null;
    createdBy?: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO panel_tokens (token_hash, user_id, label, created_by)
     VALUES ($1, $2, $3, $4)`,
    [token.tokenHash, token.userId, token.label ?? null, token.createdBy ?? null],
  );
}

/**
 * Looks up a live key by its hash.
 *
 * Returns null for a key that is unknown, revoked, or whose user has been
 * deleted — three cases that must all be "not authorised", and none of which
 * the caller may distinguish.
 */
export async function findPanelToken(
  pool: Pool,
  tokenHash: string,
): Promise<{ userId: string; lastSeenAt: Date | null } | null> {
  const result = await pool.query(
    `SELECT user_id, last_seen_at
       FROM panel_tokens
      WHERE token_hash = $1
        AND revoked_at IS NULL`,
    [tokenHash],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    userId: row.user_id,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
  };
}

/** Records that a key was used. Fire-and-forget; throttled by the caller. */
export async function touchPanelToken(pool: Pool, tokenHash: string): Promise<void> {
  await pool.query('UPDATE panel_tokens SET last_seen_at = now() WHERE token_hash = $1', [
    tokenHash,
  ]);
}

/** Cuts a key off. Kept as a timestamp rather than a delete; see the migration. */
export async function revokePanelToken(pool: Pool, tokenHash: string): Promise<boolean> {
  const result = await pool.query(
    'UPDATE panel_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Revokes every live key belonging to one user. Used when someone leaves. */
export async function revokePanelTokensForUser(pool: Pool, userId: string): Promise<number> {
  const result = await pool.query(
    `UPDATE panel_tokens
        SET revoked_at = now()
      WHERE user_id = $1
        AND revoked_at IS NULL`,
    [userId],
  );
  return result.rowCount ?? 0;
}

export interface PanelTokenRow {
  tokenHash: string;
  userId: string;
  label: string | null;
  createdBy: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Lists keys, live ones first.
 *
 * Returns the hash so the panel can revoke by identity, and the caller is
 * responsible for showing only a prefix of it. The hash is not a secret in the
 * way the key is — it cannot be replayed — but printing it in full is a habit
 * worth not forming.
 */
export async function listPanelTokens(
  pool: Pool,
  options: { includeRevoked?: boolean } = {},
): Promise<PanelTokenRow[]> {
  const result = await pool.query(
    `SELECT token_hash, user_id, label, created_by, created_at, last_seen_at, revoked_at
       FROM panel_tokens
      ${options.includeRevoked ? '' : 'WHERE revoked_at IS NULL'}
      ORDER BY revoked_at IS NULL DESC, created_at DESC`,
  );

  return result.rows.map((row) => ({
    tokenHash: row.token_hash,
    userId: row.user_id,
    label: row.label ?? null,
    createdBy: row.created_by ?? null,
    createdAt: new Date(row.created_at),
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  }));
}

/**
 * How many live keys exist.
 *
 * This is the switch that turns the panel's login screen on, so it is a count
 * of *live* rows: a deployment where every key has been revoked must fall back
 * to "no keys" rather than staying locked behind credentials that no longer
 * work.
 */
export async function countLivePanelTokens(pool: Pool): Promise<number> {
  const result = await pool.query(
    'SELECT count(*)::int AS live FROM panel_tokens WHERE revoked_at IS NULL',
  );
  return Number(result.rows[0]?.live ?? 0);
}

/** Cheap liveness probe used by `init()` and reported through /api/health. */
export async function ping(pool: Pool): Promise<boolean> {
  const res = await pool.query('SELECT 1 AS ok');
  return res.rows[0]?.ok === 1;
}

/**
 * Reads the shared change counter.
 *
 * One row, one column, no join — the point is that a replica can ask "has
 * anything moved" many times a second without it mattering. Returns null when
 * the counter does not exist, which is the honest answer for a database that
 * predates the migration rather than a number that would be mistaken for "no
 * change".
 */
export async function readDataVersion(pool: Pool): Promise<number | null> {
  try {
    const res = await pool.query('SELECT version FROM data_version WHERE id = TRUE');
    const value = res.rows[0]?.version;
    return value === undefined || value === null ? null : Number(value);
  } catch {
    // A missing table is not an error worth logging on a poll that runs once a
    // second. The caller treats null as "cannot tell", and cannot-tell must not
    // be confused with unchanged.
    return null;
  }
}
