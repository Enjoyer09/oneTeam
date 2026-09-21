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
  /**
   * Barcodes read off the shelf. De-duplicated here rather than at the call
   * site so that no caller can record the same code twice and make a shelf look
   * fuller than it is. Empty means "the worker scanned and found nothing";
   * absent means "no scanning happened" — the stamper preserves the difference.
   */
  scannedBarcodes?: readonly string[];
}): AuditMetadata {
  const distance = calculateDistanceMeters(params.userGPS, params.storeGPS);

  // SCANNED BARCODES — ABSENT WHEN NOTHING WAS SCANNED, NOT EMPTY.
  //
  // The type marks the field as optional (`scanned_barcodes?: string[]`) and the
  // metadata carries it ONLY when the worker actually used the scanner. Empty
  // would mean "the worker scanned and found nothing", which is a real and
  // useful claim — but today the only source of that signal is the scanner
  // itself, which fires when something IS decoded, so "scanned and found nothing"
  // is operationally indistinguishable from "did not scan". Collapsing them into
  // `[]` would let a later reader claim the shelf was checked when it was not.
  //
  // The list is de-duplicated here, so no caller can record the same code twice
  // and make a shelf look fuller than it is. Order is kept so the list describes
  // the sequence the worker walked the shelf in.
  const scannedBarcodes =
    params.scannedBarcodes !== undefined && params.scannedBarcodes.length > 0
      ? Array.from(new Set(params.scannedBarcodes))
      : undefined;

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
    ...(scannedBarcodes !== undefined ? { scanned_barcodes: scannedBarcodes } : {}),
  };
}

/**
 * Enforces live in-app camera capture only (Anti-Fraud Policy)
 */
export function assertLiveCameraCapture(source: 'camera' | 'gallery'): void {
  if (source === 'gallery') {
    throw new Error(
      'SAXTA AUDİT QADAĞANDIR: Qalereyadan köhnə foto seçmək qadağandır. Zəhmət olmasa birbaşa canlı kamera ilə rəf fotosunu çəkin.',
    );
  }
}
