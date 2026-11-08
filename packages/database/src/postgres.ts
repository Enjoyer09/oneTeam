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

import { clock } from '@oneteam/types';
import { Pool } from 'pg';
import type { QueryResultRow } from 'pg';
import type { Campaign, Region, TaskState } from '@oneteam/types';
import type {
  InMemoryTemplate,
  InMemoryUser,
  InMemoryShelfPosition,
  InMemoryStoreTask,
  InMemoryEvidence,
  InMemoryAuditLog,
  InMemoryStore,
  InMemoryProduct,
} from './types';

/** Everything the in-memory repository needs to start from real data. */
/**
 * A raw row as `pg` returns one.
 *
 * The library's own type (`QueryResultRow`) rather than a local one: it is the
 * shape the driver documents, and re-declaring it here would give the mappers a
 * second definition to drift from. It is deliberately untyped per column — a
 * column is whatever PostgreSQL returned, and each mapper narrows the ones it
 * uses (`asRequiredDate`, `Number`, `??`). The value of naming the parameter is
 * that a column that does not exist reads as a known hole instead of a silent
 * `undefined` from an `any`.
 */
type Row = QueryResultRow;

export interface HydratedState {
  users: InMemoryUser[];
  /** Null when the table is empty — callers must say what they do about that. */
  region: Region | null;
  stores: InMemoryStore[];
  campaign: Campaign | null;
  templates: InMemoryTemplate[];
  storeTasks: InMemoryStoreTask[];
  evidences: InMemoryEvidence[];
  auditLogs: InMemoryAuditLog[];
  products: InMemoryProduct[];
  shelfPositions: InMemoryShelfPosition[];
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

function toStoreTask(row: Row): InMemoryStoreTask {
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

function toEvidence(row: Row): InMemoryEvidence {
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
    // Null means the row was written before these columns existed. That is
    // "unknown", and it is kept as null rather than coerced to `false` — a
    // false would claim the location was checked.
    locationMocked: row.location_mocked ?? undefined,
    locationUnverified: row.location_unverified ?? undefined,
    aiScore: row.ai_score,
    aiDetections: row.ai_detections ?? [],
    aiSummary: row.ai_summary,
    reviewerFeedback: row.reviewer_feedback ?? undefined,
    submittedAt: asRequiredDate(row.submitted_at),
    createdAt: asRequiredDate(row.created_at),
    updatedAt: asRequiredDate(row.updated_at),
  };
}

function toAuditLog(row: Row): InMemoryAuditLog {
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
  const [
    users,
    regions,
    stores,
    campaigns,
    templates,
    storeTasks,
    evidences,
    auditLogs,
    products,
    shelfPositions,
  ] = await Promise.all([
    pool.query('SELECT * FROM users ORDER BY created_at'),
    pool.query('SELECT * FROM regions ORDER BY created_at'),
    pool.query('SELECT * FROM stores ORDER BY store_code'),
    pool.query('SELECT * FROM campaigns ORDER BY created_at'),
    pool.query('SELECT * FROM task_templates ORDER BY created_at'),
    pool.query('SELECT * FROM store_tasks ORDER BY created_at'),
    pool.query('SELECT * FROM task_evidences ORDER BY created_at'),
    pool.query('SELECT * FROM audit_logs ORDER BY created_at'),
    pool.query('SELECT * FROM products ORDER BY name'),
    pool.query('SELECT * FROM shelf_positions ORDER BY section, level, position'),
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
    products: products.rows.map((r) => ({
      id: r.id,
      barcode: r.barcode,
      name: r.name,
      size: r.size ?? undefined,
      variant: r.variant ?? undefined,
      createdAt: asRequiredDate(r.created_at),
      updatedAt: asRequiredDate(r.updated_at),
    })),
    shelfPositions: shelfPositions.rows.map((r) => ({
      id: r.id,
      section: r.section,
      level: r.level,
      position: r.position,
      productId: r.product_id ?? undefined,
      // SELECT * carries the wave 1.4 columns; a mapping that dropped them
      // would show every slot as "not counted" after a restart — the exact
      // half-written-column failure this file has been burned by before.
      units: r.units ?? null,
      countedAt: r.counted_at ? asRequiredDate(r.counted_at) : null,
      createdAt: asRequiredDate(r.created_at),
      updatedAt: asRequiredDate(r.updated_at),
    })),
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
        location_mocked, location_unverified,
        ai_score, ai_detections, ai_summary, reviewer_feedback,
        submitted_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
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
      // `?? null`, never `?? false`: an absent flag must stay SQL NULL so
      // it keeps meaning "unknown". A false would assert a location was
      // verified when no fix was ever captured.
      evidence.locationMocked ?? null,
      evidence.locationUnverified ?? null,
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
 * Persists a change to a store task.
 *
 * The timestamp columns are written explicitly rather than derived in SQL,
 * because the value the in-memory copy holds is the one the audit log already
 * recorded; letting the database choose its own would make the two disagree by
 * a few milliseconds for no benefit.
 *
 * WHY `deadline` IS IN THIS LIST
 * ------------------------------
 * It was not, for a long time. The statement was written for state transitions
 * and assignment, and the panel only gained the ability to edit a deadline
 * later — so an edit moved the deadline in the process's memory, answered 200,
 * rendered the new date, and left the old one in the column. It would have come
 * back on the next restart with no trace of the change.
 *
 * The task suite's read-back assertion caught it, which is the entire reason
 * that assertion exists: everything the API said was true, and the row
 * disagreed.
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
            assigned_user_id = $9,
            deadline = $10
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
      task.deadline,
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
      template.createdAt ?? clock.now(),
      template.updatedAt ?? clock.now(),
    ],
  );
}

/**
 * Applies an edit to a task template.
 *
 * The template is where a briefing's words live, and every store task created
 * from it reads them from here. Editing a template therefore edits what all of
 * its dispatched tasks say — which is correct for the panel's "one task, many
 * stores" shape, and is why the service reports how many tasks were affected
 * rather than pretending the edit touched one row.
 *
 * `id` and `created_at` are deliberately not in the SET list: an edit must not
 * be able to move a template's identity or rewrite when it was authored.
 */
export async function updateTemplateRow(
  pool: Pool,
  template: {
    id: string;
    title: string;
    description: string;
    referenceImageUrl: string;
    priority: string;
    planogramRules?: unknown[];
    requiresBeforeAfterPhoto?: boolean;
    checklistSchema?: unknown[];
    updatedAt?: Date;
  },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE task_templates
        SET title = $2, description = $3, reference_image_url = $4, priority = $5,
            planogram_rules = $6, requires_before_after_photo = $7,
            checklist_schema = $8, updated_at = $9
      WHERE id = $1`,
    [
      template.id,
      template.title,
      template.description,
      template.referenceImageUrl,
      template.priority,
      JSON.stringify(template.planogramRules ?? []),
      template.requiresBeforeAfterPhoto ?? false,
      JSON.stringify(template.checklistSchema ?? []),
      template.updatedAt ?? clock.now(),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Counts the store tasks a template has been dispatched to.
 *
 * Used to say how many rows an edit to the template reached, and to explain why
 * a template cannot simply be discarded.
 */
export async function countStoreTasksForTemplate(pool: Pool, templateId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM store_tasks WHERE template_id = $1',
    [templateId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Deletes a task template.
 *
 * Only safe for a briefing that was never dispatched: `store_tasks.template_id`
 * is `ON DELETE RESTRICT`, so the statement raises rather than cascading if any
 * store task still points at it. The caller checks that first — see
 * `EnterpriseDatabase.discardTemplate`, which uses this to undo the template
 * half of a dispatch that then failed.
 */
export async function deleteTemplateRow(pool: Pool, templateId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM task_templates WHERE id = $1', [templateId]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Deletes one store task, together with everything queued about it.
 *
 * `task_evidences.store_task_id` is `ON DELETE RESTRICT` (migration
 * 20260920000009), so this statement RAISES rather than destroying the photos
 * and checklist answers filed against the task. The caller counts the evidence
 * first and refuses with a readable `HAS_EVIDENCE` before ever reaching here —
 * see `countEvidencesForTask`. This constraint is the last line of defence for
 * the race where an audit is submitted between that count and this delete: the
 * statement fails, the transaction rolls back, and the task is left in place
 * with its evidence intact, instead of the evidence being silently cascaded
 * away. Losing a briefing is recoverable; losing the field work filed against
 * it is not.
 *
 * `notifications.store_task_id` has NO foreign key — the same reasoning as
 * `bot_sessions`, so that a supervisor can delete a task without the outbox
 * refusing — which means nothing cascades to it and it has to be deleted here.
 * Leaving those rows behind is not merely untidy. An undelivered
 * `TASK_ASSIGNED` row describes work that no longer exists, and the bot would
 * send it later, with an inline button reading "🔓 Tapşırığı aç" whose callback
 * data is the id of a task the API no longer has. The merchandiser would be
 * told about a briefing they cannot open, by the one channel that is supposed
 * to be authoritative. A queued notice for a task being deleted is not a
 * message that is merely late; it is a message that is wrong.
 *
 * The outbox is a queue, not a history — its own header says so — so the
 * delivered rows go too rather than being kept as a record of who was told
 * what. That history lives in `audit_logs`, and the retention sweep would
 * remove the delivered rows within days anyway. One invariant, easy to check:
 * the outbox holds nothing about a task that no longer exists.
 *
 * Both statements in one transaction. If the evidence FK raises on the second
 * statement, the notifications delete rolls back with it — so a task that
 * cannot be deleted does not quietly lose its queued notices along the way.
 */
export async function deleteStoreTaskRow(pool: Pool, taskId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM notifications WHERE store_task_id = $1', [taskId]);
    const result = await client.query('DELETE FROM store_tasks WHERE id = $1', [taskId]);
    await client.query('COMMIT');
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Counts the submitted evidence rows attached to a store task. */
export async function countEvidencesForTask(pool: Pool, taskId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM task_evidences WHERE store_task_id = $1',
    [taskId],
  );
  return Number(result.rows[0]?.count ?? 0);
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
      store.createdAt ?? clock.now(),
      store.updatedAt ?? clock.now(),
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
      store.updatedAt ?? clock.now(),
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

// ---------------------------------------------------------------------------
// Products (SKU catalogue — wave 1.2)
// ---------------------------------------------------------------------------

/**
 * Inserts a catalogue SKU.
 *
 * No ON CONFLICT clause, unlike `insertStoreTask`: a duplicate barcode must
 * surface as an error so the service can turn it into PRODUCT_BARCODE_TAKEN.
 * The UNIQUE constraint on `products.barcode` has no race window, which is
 * why the service never pre-checks the barcode with a SELECT.
 */
export async function insertProduct(pool: Pool, product: InMemoryProduct): Promise<void> {
  await pool.query(
    `INSERT INTO products (id, barcode, name, size, variant, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      product.id,
      product.barcode,
      product.name,
      // '' is a cleared optional field in memory; the column stores NULL.
      product.size || null,
      product.variant || null,
      product.createdAt ?? clock.now(),
      product.updatedAt ?? clock.now(),
    ],
  );
}

/**
 * Writes back the editable columns of a product.
 *
 * `id` and `created_at` are not in the SET list: an edit must not be able to
 * move a product's identity or rewrite when it was created.
 */
export async function updateProductRow(pool: Pool, product: InMemoryProduct): Promise<boolean> {
  const result = await pool.query(
    `UPDATE products
        SET barcode = $1, name = $2, size = $3, variant = $4, updated_at = $5
      WHERE id = $6`,
    [
      product.barcode,
      product.name,
      // '' is a cleared optional field in memory; the column stores NULL.
      product.size || null,
      product.variant || null,
      product.updatedAt ?? clock.now(),
      product.id,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteProductRow(pool: Pool, productId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM products WHERE id = $1', [productId]);
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Shelf map (shelf_positions — wave 1.3)
// ---------------------------------------------------------------------------

/**
 * Inserts one shelf slot.
 *
 * No ON CONFLICT clause, same as `insertProduct`: a duplicate
 * (section, level, position) must surface as an error so the service can turn
 * it into SHELF_POSITION_TAKEN. The UNIQUE constraint has no race window,
 * which is why the service never pre-checks the slot with a SELECT.
 */
export async function insertShelfPosition(pool: Pool, slot: InMemoryShelfPosition): Promise<void> {
  await pool.query(
    `INSERT INTO shelf_positions (id, section, level, position, product_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      slot.id,
      slot.section,
      slot.level,
      slot.position,
      slot.productId ?? null,
      slot.createdAt ?? clock.now(),
      slot.updatedAt ?? clock.now(),
    ],
  );
}

/**
 * Writes back the editable columns of a shelf slot.
 *
 * `id` and `created_at` are not in the SET list: an edit must not be able to
 * move a slot's identity or rewrite when it was created.
 */
export async function updateShelfPositionRow(
  pool: Pool,
  slot: InMemoryShelfPosition,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE shelf_positions
        SET section = $1, level = $2, position = $3, product_id = $4, updated_at = $5
      WHERE id = $6`,
    [
      slot.section,
      slot.level,
      slot.position,
      slot.productId ?? null,
      slot.updatedAt ?? clock.now(),
      slot.id,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Writes the latest manual count (wave 1.4).
 *
 * The layout columns are deliberately NOT in the SET list: recording a count
 * must never be able to move a slot or rewrite when it was created.
 */
export async function countShelfPositionRow(
  pool: Pool,
  slotId: string,
  units: number,
  countedAt: Date,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE shelf_positions
        SET units = $2, counted_at = $3
      WHERE id = $1`,
    [slotId, units, countedAt],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteShelfPositionRow(pool: Pool, slotId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM shelf_positions WHERE id = $1', [slotId]);
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

/**
 * Inserts a person the panel created.
 *
 * Distinct from the two `upsert*User` helpers above, which exist for a channel
 * that is meeting someone for the first time and must be forgiving. This one is
 * the operator filling in a form, so it is a plain insert: an id or an email
 * that is already taken should be a refusal the panel can show, not a silent
 * merge onto somebody else's row. The unique-violation code reaches the caller
 * through `createUser` so "this email is already used" is sayable.
 */
export async function insertUser(
  pool: Pool,
  user: {
    id: string;
    email: string;
    fullName: string;
    role: string;
    phone?: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, full_name, role, phone, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5, now(), now())`,
    [user.id, user.email, user.fullName, user.role, user.phone ?? null],
  );
}

/**
 * Writes a person's editable fields back.
 *
 * `id`, `email` and the channel identifiers are deliberately not updatable
 * here. The id is the identity everything else references; the email is a
 * unique key a mis-typed edit could collide with; and `telegram_chat_id` /
 * `mobile_device_id` are established by the channel itself, not by a panel
 * form. Changing a role or correcting a name is what this is for.
 *
 * `role` is cast explicitly because the column is the `user_role` enum, and a
 * bare text parameter would be rejected rather than coerced.
 */
export async function updateUserRow(
  pool: Pool,
  user: {
    id: string;
    fullName: string;
    role: string;
    phone?: string | null;
  },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE users
        SET full_name = $2,
            role = $3::user_role,
            phone = $4,
            updated_at = now()
      WHERE id = $1`,
    [user.id, user.fullName, user.role, user.phone ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Removes a person.
 *
 * The caller has already checked the two conditions this cannot express — the
 * submission count and the last-admin rule — so a failure here is a genuine
 * surprise: `task_evidences.submitted_by_id` is `ON DELETE RESTRICT`, so a
 * submission that arrived between the check and this statement trips it. That
 * is exactly why the caller awaits instead of firing and forgetting.
 *
 * Everything else about the row is cleaned up by the schema rather than here,
 * and the asymmetry is worth stating because it is a data-loss surface:
 * `panel_tokens` and `device_tokens` CASCADE (the person's credentials go with
 * them), `store_tasks.assigned_user_id` and `audit_logs.actor_id` are SET NULL
 * (their work stays, unattributed). So a delete cannot be undone by re-creating
 * the person: the keys are gone, and the audit trail no longer names them.
 */
export async function deleteUserRow(pool: Pool, userId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * How many audit submissions name this person as their author.
 *
 * This is the delete guard, and it is counted in the database rather than from
 * the in-memory array for the reason this project keeps re-learning: the
 * replica lags, so a submission from the last second would not be seen, the
 * delete would be allowed, and `ON DELETE RESTRICT` would then refuse it —
 * except the caller would already have told the operator it succeeded.
 */
export async function countEvidencesForUser(pool: Pool, userId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM task_evidences WHERE submitted_by_id = $1',
    [userId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * How many people hold a given role.
 *
 * Used for one rule only: the last administrator may not be demoted or removed.
 * That rule is not decoration. The panel's key management and user management
 * are both ADMIN-only, so demoting the only admin leaves a deployment nobody
 * can administer — no way to mint a key, no way to promote anyone back. It is
 * the same shape of lockout as the logout-last-key problem, and it is cheaper
 * to prevent than to explain.
 */
export async function countUsersWithRole(pool: Pool, role: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM users WHERE role = $1::user_role',
    [role],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Submission counts for everybody, in one query.
 *
 * The user list needs this per row, and asking per row would be one round trip
 * per person on a screen that is opened often. `LEFT JOIN` rather than a plain
 * `GROUP BY` so that people with no submissions come back as `0` instead of
 * being absent — an absent row would read as "unknown", and the panel would
 * then have to guess whether the delete button should be enabled.
 */
export async function countEvidencesByUser(pool: Pool): Promise<Map<string, number>> {
  const result = await pool.query<{ submitted_by_id: string; count: string }>(
    `SELECT u.id AS submitted_by_id, count(e.id)::text AS count
       FROM users u
       LEFT JOIN task_evidences e ON e.submitted_by_id = u.id
      GROUP BY u.id`,
  );
  return new Map(result.rows.map((row) => [row.submitted_by_id, Number(row.count)]));
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

export interface DeviceTokenRow {
  tokenHash: string;
  userId: string;
  deviceId: string;
  label: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Lists device credentials, live ones first.
 *
 * The panel needs this to be able to revoke anything at all: a device is
 * identified by its `deviceId`, and nothing else in the panel reports one. The
 * users list says only that somebody joined from a phone.
 *
 * Revoked rows are included when asked for, because "which phone was cut off,
 * and when" is the question asked after a phone goes missing — and a list that
 * drops the answer as soon as it is acted on cannot answer it.
 */
export async function listDeviceTokens(
  pool: Pool,
  options: { includeRevoked?: boolean } = {},
): Promise<DeviceTokenRow[]> {
  const result = await pool.query(
    `SELECT token_hash, user_id, device_id, label, created_at, last_seen_at, revoked_at
       FROM device_tokens
      ${options.includeRevoked ? '' : 'WHERE revoked_at IS NULL'}
      ORDER BY revoked_at IS NULL DESC, created_at DESC`,
  );

  return result.rows.map((row) => ({
    tokenHash: row.token_hash,
    userId: row.user_id,
    deviceId: row.device_id,
    label: row.label ?? null,
    createdAt: new Date(row.created_at),
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  }));
}

/**
 * Cuts off every live credential belonging to one installation.
 *
 * By `device_id` rather than by token hash, because this is the panel acting on
 * a phone it has never held: the hash is the device's business, and the panel
 * only ever knows which installation it wants gone.
 *
 * `revoked_at IS NULL` on `device_id`, rather than on the one row the caller
 * happens to know about. Today `device_tokens_active_device_idx` is a UNIQUE
 * partial index on exactly that predicate, so there can only ever be one live
 * row per device — but the statement is written against the invariant, not
 * against the index. A version that cut off "the newest live row" would stop
 * cutting the device off the day that index changed, and would go on reporting
 * success.
 *
 * Returns how many rows it revoked, so the caller can tell "cut off" apart from
 * "there was nothing live to cut off". Those are different answers and the
 * operator needs the right one.
 */
export async function revokeDeviceTokensForDevice(pool: Pool, deviceId: string): Promise<number> {
  const result = await pool.query(
    `UPDATE device_tokens
        SET revoked_at = now()
      WHERE device_id = $1
        AND revoked_at IS NULL`,
    [deviceId],
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Device blocks
// ---------------------------------------------------------------------------
//
// A revocation acts on a token; enrolment issues a new one. Without a block the
// two cancel out — the phone the operator cut off re-enrols on its next start
// and is back. These helpers hold a bar keyed by `device_id` that outlives any
// single token: while a block is active, enrolment refuses the device. See the
// migration for why a block is a timestamp (`cleared_at`) rather than a delete.

export interface DeviceBlockRow {
  deviceId: string;
  blockedAt: Date;
  blockedBy: string | null;
  reason: string | null;
}

/**
 * Bars a device from re-enrolling, if it is not already barred.
 *
 * `WHERE NOT EXISTS` rather than `ON CONFLICT`: the uniqueness that protects
 * this is a *partial* index (`cleared_at IS NULL`), which a bare
 * `ON CONFLICT (device_id)` does not infer — the same caveat the device-token
 * path documents. The guard makes a second block for an already-blocked device
 * a no-op instead of an error, so the revoke route can set a block
 * unconditionally without having to ask first.
 *
 * Returns true when a new block was written, false when one was already active.
 */
export async function blockDevice(
  pool: Pool,
  params: { deviceId: string; blockedBy?: string | null; reason?: string | null },
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO device_blocks (device_id, blocked_by, reason)
     SELECT $1, $2, $3
      WHERE NOT EXISTS (
        SELECT 1 FROM device_blocks
         WHERE device_id = $1
           AND cleared_at IS NULL
      )`,
    [params.deviceId, params.blockedBy ?? null, params.reason ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Whether a device currently has an active block. Read on every enrolment. */
export async function isDeviceBlocked(pool: Pool, deviceId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
       FROM device_blocks
      WHERE device_id = $1
        AND cleared_at IS NULL
      LIMIT 1`,
    [deviceId],
  );
  return result.rows.length > 0;
}

/**
 * Lifts a device's active block. Returns how many were cleared (0 or 1).
 *
 * Zero means there was nothing active to clear, which the caller answers as
 * "not found" rather than as success — the same distinction the revoke path
 * draws, and for the same reason: an operator told "unblocked" when nothing was
 * blocked would believe they had changed something they had not.
 */
export async function clearDeviceBlock(
  pool: Pool,
  params: { deviceId: string; clearedBy?: string | null },
): Promise<number> {
  const result = await pool.query(
    `UPDATE device_blocks
        SET cleared_at = now(),
            cleared_by = $2
      WHERE device_id = $1
        AND cleared_at IS NULL`,
    [params.deviceId, params.clearedBy ?? null],
  );
  return result.rowCount ?? 0;
}

/** Every active block, for the panel's device list to mark blocked rows. */
export async function listActiveDeviceBlocks(pool: Pool): Promise<DeviceBlockRow[]> {
  const result = await pool.query(
    `SELECT device_id, blocked_at, blocked_by, reason
       FROM device_blocks
      WHERE cleared_at IS NULL
      ORDER BY blocked_at DESC`,
  );
  return result.rows.map((row) => ({
    deviceId: row.device_id,
    blockedAt: new Date(row.blocked_at),
    blockedBy: row.blocked_by ?? null,
    reason: row.reason ?? null,
  }));
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

// ---------------------------------------------------------------------------
// Bot sessions — where a Telegram chat is in the guided field flow
// ---------------------------------------------------------------------------

/**
 * A chat's position in the flow, as stored.
 *
 * Field names are camelCase here and snake_case in the table, converted in one
 * place (`toBotSession`) so no caller has to remember which side it is on.
 */
export interface BotSessionRow {
  chatId: string;
  userId: string | null;
  step: string;
  storeId: string | null;
  storeCode: string | null;
  storeName: string | null;
  activeTaskId: string | null;
  activeTaskTitle: string | null;
  latitude: number | null;
  longitude: number | null;
  /** When the fix was taken, or NULL when no fix was collected. */
  locatedAt: string | null;
  checklistQuestions: unknown[];
  checklistAnswers: unknown[];
  checklistIndex: number | null;
  pendingPhoto: Record<string, unknown> | null;
  updatedAt: Date;
  expiresAt: Date;
}

function toBotSession(row: Row): BotSessionRow {
  return {
    chatId: String(row.chat_id),
    userId: row.user_id ?? null,
    step: String(row.step ?? 'idle'),
    storeId: row.store_id ?? null,
    storeCode: row.store_code ?? null,
    storeName: row.store_name ?? null,
    activeTaskId: row.active_task_id ?? null,
    activeTaskTitle: row.active_task_title ?? null,
    latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
    longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
    locatedAt:
      row.located_at === null || row.located_at === undefined || row.located_at === ''
        ? null
        : // ISO-8601, not `String(date)`. `pg` hands back a JS `Date` for a
          // timestamptz, and `String()` on one produces
          // "Tue Oct 06 2026 11:41:30 GMT+0400 (Azerbaijan Standard Time)" — a
          // value Postgres refuses on the way back in with
          // `time zone "gmt+0400" not recognised`, so the very next save of the
          // same session failed with FLOW_NOT_STORED and the bot's flow could
          // not be written at all.
          new Date(row.located_at).toISOString(),
    checklistQuestions: Array.isArray(row.checklist_questions) ? row.checklist_questions : [],
    checklistAnswers: Array.isArray(row.checklist_answers) ? row.checklist_answers : [],
    checklistIndex:
      row.checklist_index === null || row.checklist_index === undefined
        ? null
        : Number(row.checklist_index),
    pendingPhoto: row.pending_photo ?? null,
    updatedAt: new Date(row.updated_at),
    expiresAt: new Date(row.expires_at),
  };
}

/**
 * Loads a chat's session, and pushes its expiry forward in the same statement.
 *
 * WHY THE READ WRITES
 * -------------------
 * The expiry is sliding, not absolute. A merchandiser who is working — opening
 * the task list, tapping through questions — must not lose the store they are
 * bound to because fifteen minutes passed since their last *mutation*. A
 * `SELECT` followed by a separate `UPDATE` would be two round trips and two
 * chances to interleave; one statement that only returns the row when it was
 * still live is both cheaper and impossible to get wrong.
 *
 * An expired row is returned as `null` rather than deleted. Two concurrent reads
 * of the same expired row would otherwise race, and one of them would delete a
 * row the other had just refreshed.
 */
export async function readBotSession(
  pool: Pool,
  chatId: string,
  ttlSeconds: number,
): Promise<BotSessionRow | null> {
  const result = await pool.query(
    `UPDATE bot_sessions
        SET expires_at = now() + make_interval(secs => $2::double precision)
      WHERE chat_id = $1
        AND expires_at > now()
      RETURNING *`,
    [chatId, ttlSeconds],
  );

  const row = result.rows[0];
  return row ? toBotSession(row) : null;
}

/**
 * Writes a chat's whole session, creating it if this chat has none.
 *
 * The whole row rather than a patch, because the flow's state is small and
 * self-consistent: a partial update would let a caller change `checklistIndex`
 * without the matching answers and leave a session that cannot be resumed. The
 * cost is one row's worth of bytes per button tap, which is the right trade for
 * not having to reason about which fields a given step may touch.
 *
 * `expires_at` is recomputed here rather than passed in, so no caller can
 * accidentally extend or shorten the window — the TTL is a property of the
 * table's purpose, not of the request that happened to write it.
 */
export async function upsertBotSession(
  pool: Pool,
  session: {
    chatId: string;
    userId?: string | null;
    step: string;
    storeId?: string | null;
    storeCode?: string | null;
    storeName?: string | null;
    activeTaskId?: string | null;
    activeTaskTitle?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    locatedAt?: string | null;
    checklistQuestions?: unknown[];
    checklistAnswers?: unknown[];
    checklistIndex?: number | null;
    pendingPhoto?: Record<string, unknown> | null;
  },
  ttlSeconds: number,
): Promise<BotSessionRow> {
  const result = await pool.query(
    `INSERT INTO bot_sessions (
        chat_id, user_id, step,
        store_id, store_code, store_name,
        active_task_id, active_task_title,
        latitude, longitude,
        located_at,
        checklist_questions, checklist_answers, checklist_index,
        pending_photo,
        updated_at, expires_at
     ) VALUES (
        $1, $2, $3,
        $4, $5, $6,
        $7, $8,
        $9, $10,
        $11,
        $12::jsonb, $13::jsonb, $14,
        $15::jsonb,
        now(), now() + make_interval(secs => $16::double precision)
     )
     ON CONFLICT (chat_id) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            step = EXCLUDED.step,
            store_id = EXCLUDED.store_id,
            store_code = EXCLUDED.store_code,
            store_name = EXCLUDED.store_name,
            active_task_id = EXCLUDED.active_task_id,
            active_task_title = EXCLUDED.active_task_title,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            located_at = EXCLUDED.located_at,
            checklist_questions = EXCLUDED.checklist_questions,
            checklist_answers = EXCLUDED.checklist_answers,
            checklist_index = EXCLUDED.checklist_index,
            pending_photo = EXCLUDED.pending_photo,
            updated_at = now(),
            expires_at = EXCLUDED.expires_at
     RETURNING *`,
    [
      session.chatId,
      session.userId ?? null,
      session.step,
      session.storeId ?? null,
      session.storeCode ?? null,
      session.storeName ?? null,
      session.activeTaskId ?? null,
      session.activeTaskTitle ?? null,
      session.latitude ?? null,
      session.longitude ?? null,
      session.locatedAt ?? null,
      JSON.stringify(session.checklistQuestions ?? []),
      JSON.stringify(session.checklistAnswers ?? []),
      session.checklistIndex ?? null,
      session.pendingPhoto ? JSON.stringify(session.pendingPhoto) : null,
      ttlSeconds,
    ],
  );

  return toBotSession(result.rows[0]);
}

/** Forgets a chat. Used when the flow finishes or the person asks to start over. */
export async function deleteBotSession(pool: Pool, chatId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM bot_sessions WHERE chat_id = $1', [chatId]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Forgets sessions that expired longer ago than the grace period.
 *
 * The grace period matters: a row that expired a second ago is still the answer
 * to "what was this person doing", which is what somebody asks when a
 * merchandiser reports that the bot forgot their answers. An hour of that is
 * cheap and answers the question; keeping them forever is not.
 *
 * Run periodically rather than on read, so no request is ever responsible for
 * the cleanup and a slow sweep cannot delay a person's button tap.
 */
export async function sweepBotSessions(pool: Pool, graceSeconds: number): Promise<number> {
  const result = await pool.query(
    'DELETE FROM bot_sessions WHERE expires_at < now() - make_interval(secs => $1::double precision)',
    [graceSeconds],
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// notifications — the outbound message queue the bot drains
// ---------------------------------------------------------------------------

/** What happened, which is what a reader filters on. The text is separate. */
export type NotificationKind = 'TASK_ASSIGNED' | 'TASK_REJECTED' | 'DEADLINE_SOON';

/**
 * A message waiting to be delivered to a Telegram chat.
 *
 * camelCase here, snake_case in the table, converted in one place
 * (`toNotification`) so no caller has to remember which side it is on.
 */
export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  chatId: string | null;
  userId: string | null;
  storeTaskId: string | null;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  createdAt: Date;
  claimedAt: Date | null;
  claimedBy: string | null;
  deliveredAt: Date | null;
  failedAt: Date | null;
  failure: string | null;
  attempts: number;
}

function toNotification(row: Row): NotificationRow {
  return {
    id: String(row.id),
    kind: String(row.kind) as NotificationKind,
    chatId: row.chat_id === null || row.chat_id === undefined ? null : String(row.chat_id),
    userId: row.user_id ?? null,
    storeTaskId: row.store_task_id ?? null,
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    payload: row.payload && typeof row.payload === 'object' ? row.payload : {},
    dedupeKey: String(row.dedupe_key ?? ''),
    createdAt: new Date(row.created_at),
    claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
    claimedBy: row.claimed_by ?? null,
    deliveredAt: row.delivered_at ? new Date(row.delivered_at) : null,
    failedAt: row.failed_at ? new Date(row.failed_at) : null,
    failure: row.failure ?? null,
    attempts: Number(row.attempts ?? 0),
  };
}

/**
 * Records the intent to notify. Returns null when this exact notification was
 * already recorded.
 *
 * IDEMPOTENT BY THE DATABASE, NOT BY A CHECK
 * ------------------------------------------
 * `dedupe_key` is UNIQUE and the insert is `ON CONFLICT DO NOTHING`, so two
 * callers racing on the same event cannot both enqueue it. A `SELECT` followed
 * by an `INSERT` would look equivalent and would not be: the deadline sweep runs
 * on a timer and a task publish can be retried by a supervisor, so the same
 * event genuinely does arrive twice.
 *
 * `null` therefore means "already queued", which is not an error and must not be
 * reported as one — the caller's job was to make sure this message would be
 * sent, and it will be.
 */
export async function insertNotification(
  pool: Pool,
  notification: {
    id: string;
    kind: NotificationKind;
    chatId?: string | null;
    userId?: string | null;
    storeTaskId?: string | null;
    title: string;
    body: string;
    payload?: Record<string, unknown>;
    dedupeKey: string;
  },
): Promise<NotificationRow | null> {
  const result = await pool.query(
    `INSERT INTO notifications (
        id, kind, chat_id, user_id, store_task_id,
        title, body, payload, dedupe_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING *`,
    [
      notification.id,
      notification.kind,
      notification.chatId ?? null,
      notification.userId ?? null,
      notification.storeTaskId ?? null,
      notification.title,
      notification.body,
      JSON.stringify(notification.payload ?? {}),
      notification.dedupeKey,
    ],
  );

  const row = result.rows[0];
  return row ? toNotification(row) : null;
}

/**
 * Takes the oldest undelivered messages and leases them to one caller.
 *
 * WHY `FOR UPDATE SKIP LOCKED` AND NOT A PLAIN SELECT
 * ---------------------------------------------------
 * Two bot instances overlap for a few seconds on every deploy. Without a claim,
 * both would read the same pending rows and the merchandiser would get the same
 * notification twice. `SKIP LOCKED` means the second instance walks past rows
 * the first is already taking and picks up the next ones instead of waiting.
 *
 * The lease is a timestamp rather than a lock held for the duration of the
 * request: the send happens outside the transaction (it is a call to Telegram),
 * so the claim has to survive the transaction ending. A bot killed between
 * claiming and sending leaves a claim that expires, and the row becomes
 * available again — which is what makes this at-least-once instead of
 * at-most-once. A lost notification is the bug this table exists to fix, so
 * erring towards a duplicate is deliberate.
 */
export async function claimNotifications(
  pool: Pool,
  options: { chatId?: string | null; limit?: number; claimedBy: string; leaseSeconds: number },
): Promise<NotificationRow[]> {
  const result = await pool.query(
    `UPDATE notifications
        SET claimed_at = now(),
            claimed_by = $3,
            attempts = attempts + 1
      WHERE id IN (
              SELECT id
                FROM notifications
               WHERE delivered_at IS NULL
                 AND failed_at IS NULL
                 AND chat_id IS NOT NULL
                 AND ($1::text IS NULL OR chat_id = $1)
                 AND (claimed_at IS NULL
                      OR claimed_at < now() - make_interval(secs => $4::double precision))
               ORDER BY created_at
               LIMIT $2
               FOR UPDATE SKIP LOCKED
            )
      RETURNING *`,
    [options.chatId ?? null, options.limit ?? 20, options.claimedBy, options.leaseSeconds],
  );

  return result.rows.map(toNotification);
}

/** Records that the message reached Telegram. */
export async function markNotificationDelivered(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE notifications
        SET delivered_at = now(), failure = NULL
      WHERE id = $1 AND delivered_at IS NULL
      RETURNING id`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Records that Telegram refused it.
 *
 * `failed_at` is terminal rather than a retry counter, because the failures that
 * reach here are the ones a retry cannot fix: the chat blocked the bot, the chat
 * id no longer exists, the message was rejected as malformed. Retrying those
 * forever would be a queue that never drains and a log nobody reads. A transient
 * failure never arrives here at all — the bot does not mark it, so the lease
 * expires and the row is picked up again.
 */
export async function markNotificationFailed(
  pool: Pool,
  id: string,
  failure: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE notifications
        SET failed_at = now(), failure = $2
      WHERE id = $1 AND delivered_at IS NULL AND failed_at IS NULL
      RETURNING id`,
    [id, failure.slice(0, 500)],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Drops rows that have stopped being useful, on three separate clocks.
 *
 * Same shape and same reasoning as the bot-session sweep: a maintenance job on a
 * timer rather than work attached to a request, so no merchandiser's button tap
 * is ever responsible for a table scan.
 *
 * WHY THREE CASES AND NOT ONE
 * ---------------------------
 * `created_at` alone is the wrong clock for a delivered row — a message created
 * eight days ago and delivered today would be deleted the moment it arrived.
 * Each case therefore measures from the moment that made the row dead:
 *
 *   1. delivered — the message was sent, so the row is a receipt
 *   2. failed    — the message will never be sent; the reason is in `failure`
 *   3. no destination — `chat_id IS NULL`, which means the assignee had never
 *      spoken to the bot. `claimNotifications` will never take it, so without
 *      this case those rows would accumulate forever. They are kept for the
 *      retention window because that is how long "this person was never told"
 *      is worth being able to see.
 *
 * A row with a chat id that is neither delivered nor failed is deliberately
 * NEVER deleted, however old it is: it is an unsent message, and deleting it
 * would be the exact loss this table was created to prevent. The lease makes it
 * claimable again the moment a bot process comes back.
 */
export async function sweepNotifications(pool: Pool, retentionSeconds: number): Promise<number> {
  const result = await pool.query(
    `DELETE FROM notifications
      WHERE (delivered_at IS NOT NULL
             AND delivered_at < now() - make_interval(secs => $1::double precision))
         OR (failed_at IS NOT NULL
             AND failed_at < now() - make_interval(secs => $1::double precision))
         OR (delivered_at IS NULL
             AND failed_at IS NULL
             AND chat_id IS NULL
             AND created_at < now() - make_interval(secs => $1::double precision))`,
    [retentionSeconds],
  );
  return result.rowCount ?? 0;
}
