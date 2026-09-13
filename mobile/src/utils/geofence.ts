import { GPSCoordinates, GeofenceResult } from '../types';

const EARTH_RADIUS_METERS = 6371000; // Earth's mean radius in meters
export const DEFAULT_GEOFENCE_RADIUS_METERS = 100; // 100-meter threshold

/**
 * Converts degrees to radians
 */
function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Calculates the great-circle distance between two GPS coordinates using the Haversine formula
 */
export function calculateDistanceMeters(
  coord1: GPSCoordinates,
  coord2: GPSCoordinates
): number {
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
  thresholdMeters: number = DEFAULT_GEOFENCE_RADIUS_METERS
): GeofenceResult {
  const distance = calculateDistanceMeters(userGPS, storeGPS);
  const roundedDist = Math.round(distance);

  const isWithin = distance <= thresholdMeters;

  let message = '';
  if (isWithin) {
    message = `✅ Məkân təsdiqləndi: Mağaza ərazisindəsiniz (${roundedDist}m)`;
  } else {
    message = `⚠️ Siz mağaza ərazisində deyilsiniz (Məsafə: ${roundedDist}m). Rəf auditi yalnız mağaza daxilində (maksimum ${thresholdMeters}m radius) təsdiqlənə bilər.`;
  }

  return {
    isWithinGeofence: isWithin,
    distanceMeters: roundedDist,
    thresholdMeters,
    message,
  };
}
