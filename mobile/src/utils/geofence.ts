import { GPSCoordinates, GeofenceResult } from '../types';

const EARTH_RADIUS_METERS = 6371000; // Earth's mean radius in meters
export const DEFAULT_GEOFENCE_RADIUS_METERS = 100; // 100-meter threshold

/**
 * Above this reported accuracy (in meters) a fix is treated as low-confidence.
 *
 * A GPS reading that is only good to a few hundred meters cannot honestly place
 * a worker inside a store-sized geofence, and a fix with no accuracy reading at
 * all tells us nothing about how much to trust it. Neither is refused outright —
 * a basement fix is still worth queuing — but both are flagged so the server can
 * record them as weaker evidence rather than the client silently passing them.
 */
export const LOW_CONFIDENCE_ACCURACY_METERS = 100;

/**
 * Whether a fix is too imprecise (or too unqualified) to trust on its own.
 *
 * Missing accuracy counts as low-confidence: "the platform did not say how good
 * this is" is not the same as "this is good", and treating it as good is exactly
 * the silent pass this exists to stop.
 */
export function isLowConfidenceFix(
  gps: Pick<GPSCoordinates, 'accuracy'>,
  thresholdMeters: number = LOW_CONFIDENCE_ACCURACY_METERS,
): boolean {
  return typeof gps.accuracy !== 'number' || gps.accuracy > thresholdMeters;
}

/**
 * Converts degrees to radians
 */
function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Calculates the great-circle distance between two GPS coordinates using the Haversine formula
 */
export function calculateDistanceMeters(coord1: GPSCoordinates, coord2: GPSCoordinates): number {
  const dLat = toRadians(coord2.latitude - coord1.latitude);
  const dLon = toRadians(coord2.longitude - coord1.longitude);

  const lat1 = toRadians(coord1.latitude);
  const lat2 = toRadians(coord2.latitude);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}

/**
 * Verifies if user's current GPS position is within the store's allowed geofence perimeter (Anti-Fraud)
 */
export function verifyStoreGeofence(
  userGPS: GPSCoordinates,
  storeGPS: GPSCoordinates,
  thresholdMeters: number = DEFAULT_GEOFENCE_RADIUS_METERS,
): GeofenceResult {
  const distance = calculateDistanceMeters(userGPS, storeGPS);
  const roundedDist = Math.round(distance);

  const isWithin = distance <= thresholdMeters;
  const lowConfidence = isLowConfidenceFix(userGPS);

  let message: string;
  if (isWithin) {
    message = `✅ Məkân təsdiqləndi: Mağaza ərazisindəsiniz (${roundedDist}m)`;
  } else {
    message = `⚠️ Siz mağaza ərazisində deyilsiniz (Məsafə: ${roundedDist}m). Rəf auditi yalnız mağaza daxilində (maksimum ${thresholdMeters}m radius) təsdiqlənə bilər.`;
  }

  // Appended, not substituted: the distance verdict above is unchanged, and this
  // adds an honest caveat rather than overriding it. A low-confidence fix that
  // lands inside is still "inside", but a supervisor should know the position it
  // was judged against was imprecise.
  if (lowConfidence) {
    const accuracyNote =
      typeof userGPS.accuracy === 'number'
        ? `±${Math.round(userGPS.accuracy)}m`
        : 'dəqiqlik bildirilmədi';
    message += ` ⚠️ GPS dəqiqliyi aşağıdır (${accuracyNote}) — mövqe təxminidir.`;
  }

  return {
    isWithinGeofence: isWithin,
    distanceMeters: roundedDist,
    thresholdMeters,
    message,
    accuracyMeters: typeof userGPS.accuracy === 'number' ? userGPS.accuracy : undefined,
    locationLowConfidence: lowConfidence,
  };
}
