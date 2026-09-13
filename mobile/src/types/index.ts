export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskStatus = 'draft' | 'published' | 'completed' | 'archived';
export type SubmissionStatus = 'pending_review' | 'approved' | 'rejected';

export interface MobileStore {
  id: string;
  store_code: string;
  name: string;
  address: string | null;
  city: string;
  latitude: number;
  longitude: number;
  is_active: boolean;
}

export interface MobileTask {
  id: string;
  title: string;
  description: string;
  reference_image_url: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  deadline: string;
  cooling_requirement?: string; // e.g. "≤ 4°C"
  facings_per_sku?: number; // e.g. 3
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

export interface AuditMetadata {
  gps: GPSCoordinates;
  distance_from_store_meters: number;
  device_model: string;
  os_version: string;
  captured_at: string;
  capture_mode: 'live_camera_only'; // anti-fraud indicator
  ghost_overlay_used: boolean;
  app_version: string;
}

export interface QueueItem {
  id: string;
  task_id: string;
  store_id: string;
  photo_uri: string;
  metadata: AuditMetadata;
  created_at: string;
  retry_count: number;
  sync_status: 'queued' | 'syncing' | 'failed' | 'synced';
  error_message?: string;
}

export interface MobileSubmission {
  id: string;
  task_id: string;
  store_id: string;
  photo_url: string;
  status: SubmissionStatus;
  reviewer_feedback: string | null;
  ai_score?: number | null;
  ai_detections?: any;
  ai_summary?: string | null;
  submitted_at: string;
  metadata: AuditMetadata;
  is_offline_synced?: boolean;
}
