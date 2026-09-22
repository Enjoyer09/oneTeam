// `import type`, deliberately — and it is not a style preference.
//
// `mobile` is NOT a workspace member (it has its own lockfile and is installed
// separately), so `@oneteam/types` is not in this package's dependencies. The
// import only resolves because `mobile/` happens to sit inside the monorepo and
// Node walks up to the root `node_modules`. In a standalone Expo build — an EAS
// build, or a fresh clone where only `mobile/` was installed — there is nothing
// to resolve.
//
// Both symbols below are used in TYPE POSITIONS only, so `import type` makes the
// erasure explicit and guarantees the bundler drops the import instead of
// emitting a runtime `require` that would fail exactly there. It also means the
// mobile app genuinely has no runtime dependency on the shared package, which is
// the truth.
import type { ChecklistQuestion, PlanogramRule } from '@oneteam/types';

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskStatus = 'draft' | 'published' | 'completed' | 'archived';
export type SubmissionStatus = 'pending_review' | 'approved' | 'rejected';

/**
 * A store as the mobile client sees it.
 *
 * `latitude`/`longitude` are nullable because the API says so: a store can exist
 * in the catalogue before anyone has recorded where it is. That is not a detail
 * to smooth over — the anti-fraud geofence cannot run without them, so the login
 * screen refuses such a store explicitly rather than comparing against a
 * default of 0,0 and reporting a distance from the Gulf of Guinea.
 */
export interface MobileStore {
  id: string;
  store_code: string;
  name: string;
  address: string | null;
  city: string;
  latitude: number | null;
  longitude: number | null;
  is_active: boolean;
}

/**
 * A task as the mobile client sees it.
 *
 * These are store tasks, not templates: one row per (template, store), which is
 * what the submission endpoint takes an id of. `planogram_rules` and
 * `checklist_schema` come from the template behind it.
 */
export interface MobileTask {
  id: string;
  title: string;
  description: string;
  reference_image_url: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  deadline: string;
  planogram_rules: PlanogramRule[];
  checklist_schema: ChecklistQuestion[];
}

export interface GPSCoordinates {
  latitude: number;
  longitude: number;
  accuracy?: number; // in meters
}

export interface GeofenceResult {
  isWithinGeofence: boolean;
  distanceMeters: number;
  thresholdMeters: number;
  message: string;
}

/**
 * What the device stamps onto a capture.
 *
 * This is the metadata the *client* produces. It is sent to the API as channel
 * metadata and written to the audit log; it is deliberately not what comes back
 * on a submission, which carries only the coordinates and timestamp the server
 * recorded. The two used to be conflated, which is why `MobileSubmission` no
 * longer claims to hold this shape.
 */
export interface AuditMetadata {
  gps: GPSCoordinates;
  distance_from_store_meters: number;
  device_model: string;
  os_version: string;
  captured_at: string;
  capture_mode: 'live_camera_only'; // anti-fraud indicator
  ghost_overlay_used: boolean;
  app_version: string;
  /**
   * Barcodes read off the shelf while this audit was being captured.
   *
   * Absent when nothing was scanned, rather than empty: "no barcodes were
   * scanned" and "the scanner was never used" are the same thing today, and
   * collapsing them into `[]` would let a later reader claim the shelf was
   * checked when it was not.
   *
   * Duplicates are removed but ORDER IS KEPT, so the list reads as the sequence
   * the worker walked the shelf in.
   */
  scanned_barcodes?: string[];
  /**
   * What the capture-time quality heuristic made of the photo.
   *
   * `status` is three-valued on purpose. `ok` and `flagged` are verdicts;
   * `no_signal` says the heuristic could not judge at all, because the device
   * reported no usable EXIF. A single boolean would render `no_signal` as
   * "fine", which is the one reading it must never get: a supervisor would see
   * an assessed photo where none was assessed.
   *
   * `flagged` does NOT mean the photo was withheld — the worker is warned and
   * may still send it, because a dark basement photo of the right shelf is
   * worth more than no evidence. It means a supervisor should look closer.
   *
   * Absent when the caller did not run the heuristic at all, so "not judged"
   * and "judged and fine" stay distinguishable too.
   */
  photo_quality?: {
    status: 'ok' | 'flagged' | 'no_signal';
    reasons: string[];
    metrics: {
      iso?: number;
      exposure_time_seconds?: number;
      f_number?: number;
      brightness_value?: number;
    };
  };
}

export interface QueueItem {
  id: string;
  task_id: string;
  store_id: string;
  photo_uri: string;
  /**
   * The image itself, when the platform could read it.
   *
   * Queued alongside the path rather than instead of it, because the file at
   * `photo_uri` may be gone by the time the queue drains — a phone reclaims
   * temporary files, and a queued audit that cannot be uploaded is worse than one
   * that was never queued. When this is absent the sync fails with a message
   * saying so rather than filing a placeholder image as evidence.
   */
  photo_base64?: string;
  metadata: AuditMetadata;
  created_at: string;
  retry_count: number;
  sync_status: 'queued' | 'syncing' | 'failed' | 'synced';
  error_message?: string;
}

/**
 * A filed audit as the API returns it.
 *
 * `metadata` is the server's own record — captured timestamp, the coordinates it
 * stored, the distance it computed — not the device metadata that was sent. The
 * verdict lives on the *task*, not on the evidence, so `status` is derived
 * server-side and is the only thing worth trusting here.
 */
export interface MobileSubmission {
  id: string;
  task_id: string;
  store_id: string;
  photo_url: string;
  status: SubmissionStatus;
  reviewer_feedback: string | null;
  ai_score?: number | null;
  ai_detections?: unknown;
  ai_summary?: string | null;
  submitted_at: string;
  metadata: Record<string, unknown>;
  is_offline_synced?: boolean;
}
