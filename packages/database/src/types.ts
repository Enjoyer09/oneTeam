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

import type { TaskState } from '@oneteam/types';

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
  checklistAnswers?: any[];
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
  aiDetections?: any[];
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
  payload?: any;
  createdAt: Date;
}
