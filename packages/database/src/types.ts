/**
 * oneTeam — in-memory record shapes
 * ============================================================================
 *
 * These interfaces live in their own module rather than in index.ts so that
 * postgres.ts can describe what it loads without importing index.ts, which
 * imports postgres.ts. A cycle between the two would work at runtime but makes
 * the module graph depend on load order, which is exactly the kind of thing
 * that breaks the day someone adds a top-level call.
 *
 * They are re-exported from index.ts, so `import { InMemoryStoreTask } from
 * '@oneteam/database'` keeps working.
 */

import type { ChecklistAnswer, DetectionItem, TaskState, TaskTemplate, User } from '@oneteam/types';

/**
 * A retail point, as the process holds it.
 *
 * This type did not exist while stores were read-only seed data — the shape
 * lived only inside `SeedData.stores`. It has one now because stores became
 * writable: the panel creates, edits and deletes them, and a write path without
 * a declared shape is where a typo in a column name survives until someone
 * wonders why the city is always "Bakı".
 *
 * `regionId` is required, matching `stores.region_id NOT NULL REFERENCES
 * regions(id)`. The process holds exactly one region (`db.region`, singular),
 * so new stores take that id — but the column is stated here so that adding a
 * second region is a type error at every construction site rather than a
 * silent NULL.
 *
 * The two timestamps are optional because the seeded stores genuinely have
 * none: `SeedData.stores` never declared them. Every store that has been
 * through the write path does have them, so the write path always sets them and
 * only the read of legacy seed data can find them missing — which is the same
 * situation `iso()` in the portal service already handles.
 */
export interface InMemoryStore {
  id: string;
  storeCode: string;
  name: string;
  regionId: string;
  chainName: string;
  storeFormat: 'hypermarket' | 'supermarket' | 'express' | 'convenience';
  address: string;
  city: string;
  latitude: number;
  longitude: number;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * A catalogue SKU, as the process holds it.
 *
 * Wave 1.2 of the Shelf Map plan: the barcode scanner resolves
 * `barkod → məhsul`, and the panel maintains the mapping. `size` and
 * `variant` are optional because plenty of products are fully described by
 * their name, and the column is nullable in the table for the same reason.
 */
export interface InMemoryProduct {
  id: string;
  barcode: string;
  name: string;
  size?: string;
  variant?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * One slot of the shelf map (wave 1.3): section / level / position, and the
 * product assigned to it — or nothing, because an unassigned slot is a real
 * state the panel renders as an empty position rather than a broken row.
 */
export interface InMemoryShelfPosition {
  id: string;
  section: string;
  level: number;
  position: number;
  /**
   * FK to products.id, ON DELETE RESTRICT — an assigned product cannot vanish.
   *
   * `null` is a real edit: it clears the assignment (see `updateShelfPosition`,
   * which is why the store type has to carry it separately from `undefined`).
   */
  productId?: string | null;
  /**
   * The latest manual count for this slot (wave 1.4) — current state, not a
   * history. null (or undefined) = nobody has counted it, which is NOT the
   * same as 0 (counted, and the product is absent): OSA treats those two as
   * different answers, so the distinction is load-bearing.
   */
  units?: number | null;
  /** When `units` was last recorded; null alongside it. */
  countedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface InMemoryStoreTask {
  id: string;
  templateId: string;
  storeId: string;
  assignedUserId?: string;
  status: TaskState;
  deadline: Date;
  publishedAt?: Date;
  deliveredAt?: Date;
  acknowledgedAt?: Date;
  submittedAt?: Date;
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface InMemoryEvidence {
  id: string;
  storeTaskId: string;
  submittedById: string;
  photoUrl: string;
  photoType?: 'before' | 'after' | 'standard';
  checklistAnswers?: ChecklistAnswer[];
  latitude: number;
  longitude: number;
  gpsDistanceMeters: number;
  /**
   * The device flagged this fix as mock/simulated (Android). A mock fix is held
   * for mandatory human review: it never auto-approves, and a supervisor's
   * approval is recorded as a deliberate `LOCATION_MOCK_OVERRIDE`.
   */
  locationMocked?: boolean;
  /**
   * No real fix was captured at all — the Telegram channel's skip button, or a
   * device that declined the location prompt. The API substituted the store's
   * coordinates so the geofence could run, so a passed geofence here proves
   * nothing about where anyone was.
   *
   * Kept separate from `locationMocked` because they are different defects:
   * mocked is a device saying "this is a lie", this is "there was nothing".
   * Both block auto-approval.
   */
  locationUnverified?: boolean;
  /**
   * AI vision results.
   *
   * `null` is deliberate and distinct from `undefined`:
   *   - `undefined` / absent -> the field was never set on this record
   *   - `null`               -> the AI pass ran but produced no result yet
   *   - value                -> the AI pass produced a result
   *
   * These were declared as plain optionals (`aiScore?: number`), which made
   * the `null` written by EvidenceService a type error (TS2322). Widening the
   * type is the honest fix: the stored state really does have three cases.
   */
  aiScore?: number | null;
  aiDetections?: DetectionItem[];
  aiSummary?: string | null;
  reviewerFeedback?: string;
  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface InMemoryAuditLog {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  fromState?: string;
  toState?: string;
  actorId?: string;
  payload?: Record<string, unknown> | null;
  createdAt: Date;
}

/**
 * A user row as this repository stores one.
 *
 * `User` plus the one field this repository owns: `mobileDeviceId`, the mobile
 * channel's identity key. It lives here rather than in `domain.ts` because the
 * domain has no concept of a device enrolment — only the storage layer does.
 * (Its twin is `telegramChatId`, which the domain does carry.)
 */
export interface InMemoryUser extends User {
  mobileDeviceId?: string | null;
}

/**
 * A task template row as this repository stores one.
 *
 * The domain shape already describes it exactly, so this is an alias rather than
 * a second definition: two declarations of one row is how a mapper's return type
 * and its column list drift apart.
 */
export type InMemoryTemplate = TaskTemplate;
