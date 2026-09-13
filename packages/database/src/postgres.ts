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
import type {
  InMemoryStoreTask,
  InMemoryEvidence,
  InMemoryAuditLog,
} from './types';

/** Everything the in-memory repository needs to start from real data. */
export interface HydratedState {
  users: any[];
  region: any;
  stores: any[];
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
    connectionTimeoutMillis: 10_000,
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
    ]
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
    ]
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
    ]
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
            updated_at = $8
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
    ]
  );
}

/** Cheap liveness probe used by `init()` and reported through /api/health. */
export async function ping(pool: Pool): Promise<boolean> {
  const res = await pool.query('SELECT 1 AS ok');
  return res.rows[0]?.ok === 1;
}
