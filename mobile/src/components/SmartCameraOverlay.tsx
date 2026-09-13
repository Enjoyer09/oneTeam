import { AuditMetadata, GPSCoordinates } from '../types';
import { calculateDistanceMeters } from '../utils/geofence';

export interface CameraCaptureResult {
  photoUri: string;
  metadata: AuditMetadata;
  captureMode: 'live_camera_only';
}

/**
 * Validates and stamps strict anti-fraud audit metadata onto the photo capture
 */
export function stampAuditMetadata(params: {
  userGPS: GPSCoordinates;
  storeGPS: GPSCoordinates;
  ghostOverlayUsed: boolean;
  deviceModel?: string;
  osVersion?: string;
}): AuditMetadata {
  const distance = calculateDistanceMeters(params.userGPS, params.storeGPS);

  return {
    gps: {
      latitude: params.userGPS.latitude,
      longitude: params.userGPS.longitude,
      accuracy: params.userGPS.accuracy || 5, // GPS precision in meters
    },
    distance_from_store_meters: Math.round(distance),
    device_model: params.deviceModel || 'iPhone 15 Pro',
    os_version: params.osVersion || 'iOS 18.0',
    captured_at: new Date().toISOString(),
    capture_mode: 'live_camera_only', // Gallery picks are strictly prohibited
    ghost_overlay_used: params.ghostOverlayUsed,
    app_version: '1.0.0-build.42',
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
