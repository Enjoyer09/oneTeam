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
