import { AuditMetadata, GPSCoordinates } from '../types';
import { calculateDistanceMeters } from '../utils/geofence';

export interface CameraCaptureResult {
  photoUri: string;
  metadata: AuditMetadata;
  captureMode: 'live_camera_only';
}

/**
 * Stamped when the platform did not report a value.
 *
 * These three fields used to default to `'iPhone 15 Pro'`, `'iOS 18.0'` and
 * `'1.0.0-build.42'` — invented device facts, written into the audit trail as
 * though the app had read them off the phone. A supervisor looking at that
 * record could not tell a genuine iPhone from a fabrication, which makes the
 * whole field worthless. "unknown" is worth more than a plausible guess.
 */
export const UNKNOWN_DEVICE_FIELD = 'unknown';

/**
 * Validates and stamps strict anti-fraud audit metadata onto the photo capture
 *
 * The GPS is real — it is the fix the device reported. The device identity is
 * only real if the caller passes it, which a shipping build reads from the
 * platform and this harness cannot.
 */
export function stampAuditMetadata(params: {
  userGPS: GPSCoordinates;
  storeGPS: GPSCoordinates;
  ghostOverlayUsed: boolean;
  deviceModel?: string;
  osVersion?: string;
  appVersion?: string;
}): AuditMetadata {
  const distance = calculateDistanceMeters(params.userGPS, params.storeGPS);

  return {
    gps: {
      latitude: params.userGPS.latitude,
      longitude: params.userGPS.longitude,
      accuracy: params.userGPS.accuracy || 5, // GPS precision in meters
    },
    distance_from_store_meters: Math.round(distance),
    device_model: params.deviceModel || UNKNOWN_DEVICE_FIELD,
    os_version: params.osVersion || UNKNOWN_DEVICE_FIELD,
    captured_at: new Date().toISOString(),
    capture_mode: 'live_camera_only', // Gallery picks are strictly prohibited
    ghost_overlay_used: params.ghostOverlayUsed,
    app_version: params.appVersion || UNKNOWN_DEVICE_FIELD,
  };
}

/**
 * Enforces live in-app camera capture only (Anti-Fraud Policy)
 */
export function assertLiveCameraCapture(source: 'camera' | 'gallery'): void {
  if (source === 'gallery') {
    throw new Error(
      'SAXTA AUDİT QADAĞANDIR: Qalereyadan köhnə foto seçmək qadağandır. Zəhmət olmasa birbaşa canlı kamera ilə rəf fotosunu çəkin.'
    );
  }
}
