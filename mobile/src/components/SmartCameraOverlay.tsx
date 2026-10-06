import { AuditMetadata, GPSCoordinates } from '../types';
import { calculateDistanceMeters } from '../utils/geofence';
import { photoQualityStatus, type PhotoQualityAssessment } from '../utils/photoQuality';

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
   * Whether `userGPS` is a fresh fix taken at the moment of capture (`true`) or
   * the weaker sign-in position (`false`). Optional because a caller that did
   * not resolve a capture position has nothing to assert — and the stamper keeps
   * "did not resolve" distinct from "resolved to the sign-in fix", just as it
   * does for the other three-valued fields below.
   */
  locationIsFresh?: boolean;
  /**
   * Barcodes read off the shelf. De-duplicated here rather than at the call
   * site so that no caller can record the same code twice and make a shelf look
   * fuller than it is. Empty means "the worker scanned and found nothing";
   * absent means "no scanning happened" — the stamper preserves the difference.
   */
  scannedBarcodes?: readonly string[];
  /**
   * The capture-time quality verdict, when the caller ran the heuristic.
   *
   * The stamper does not run it: the assessment needs the EXIF the platform
   * returned with the bytes, and only the screen has that. What the stamper
   * does is refuse to lose the three-valued status — see `AuditMetadata` for
   * why `no_signal` must not collapse into `ok`.
   */
  photoQuality?: PhotoQualityAssessment;
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

  // PHOTO QUALITY — SNAKE_CASE ON THE WIRE, THREE-VALUED ON PURPOSE.
  //
  // The metric names are translated here rather than spread through, so the
  // audit record's field names do not silently follow a rename inside the
  // heuristic. `no_signal` is carried through unchanged: it is the whole
  // reason the status has three values instead of two.
  const photoQuality =
    params.photoQuality !== undefined
      ? {
          status: photoQualityStatus(params.photoQuality),
          reasons: [...params.photoQuality.reasons],
          metrics: {
            ...(params.photoQuality.metrics.iso !== undefined
              ? { iso: params.photoQuality.metrics.iso }
              : {}),
            ...(params.photoQuality.metrics.exposureTimeSeconds !== undefined
              ? { exposure_time_seconds: params.photoQuality.metrics.exposureTimeSeconds }
              : {}),
            ...(params.photoQuality.metrics.fNumber !== undefined
              ? { f_number: params.photoQuality.metrics.fNumber }
              : {}),
            ...(params.photoQuality.metrics.brightnessValue !== undefined
              ? { brightness_value: params.photoQuality.metrics.brightnessValue }
              : {}),
          },
        }
      : undefined;

  return {
    gps: {
      latitude: params.userGPS.latitude,
      longitude: params.userGPS.longitude,
      // The REAL reported accuracy, or absent when the platform gave none.
      //
      // This used to be `params.userGPS.accuracy || 5` — a missing reading was
      // silently rewritten to a plausible 5 m, which made an unqualified fix look
      // like a precise one in the audit trail. That is the exact "silently pass a
      // weak fix" defect the anti-fraud pass exists to close, so the value is
      // preserved as-is and `submitAudit` flags a low-confidence fix downstream.
      ...(typeof params.userGPS.accuracy === 'number' ? { accuracy: params.userGPS.accuracy } : {}),
      // The platform's mock-location flag, when it reported one (Android). Carried
      // so the server can flag a spoofed position; absent on iOS, where the
      // platform does not expose it.
      ...(typeof params.userGPS.mocked === 'boolean' ? { mocked: params.userGPS.mocked } : {}),
      // The fix's own timestamp, passed through for the same reason as `mocked`:
      // the server rejects an undated fix, so dropping it here would make every
      // photo submitted through this overlay fail.
      ...(typeof params.userGPS.timestamp === 'number'
        ? { timestamp: params.userGPS.timestamp }
        : {}),
    },
    distance_from_store_meters: Math.round(distance),
    device_model: params.deviceModel || UNKNOWN_DEVICE_FIELD,
    os_version: params.osVersion || UNKNOWN_DEVICE_FIELD,
    captured_at: new Date().toISOString(),
    capture_mode: 'live_camera_only', // Gallery picks are strictly prohibited
    ghost_overlay_used: params.ghostOverlayUsed,
    app_version: params.appVersion || UNKNOWN_DEVICE_FIELD,
    // FRESHNESS — CARRIED ONLY WHEN THE CALLER RESOLVED A POSITION.
    //
    // `true` says the GPS above was taken at the shutter; `false` says it is the
    // sign-in fix the capture fell back to. Absent when the caller did not pass a
    // verdict at all, so "not resolved" does not masquerade as "fresh". This is
    // the durable form of the stale-position banner the worker sees at capture.
    ...(typeof params.locationIsFresh === 'boolean'
      ? { location_is_fresh: params.locationIsFresh }
      : {}),
    ...(scannedBarcodes !== undefined ? { scanned_barcodes: scannedBarcodes } : {}),
    ...(photoQuality !== undefined ? { photo_quality: photoQuality } : {}),
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
