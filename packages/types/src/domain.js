"use strict";
/**
 * oneTeam Retail Execution Platform — Domain Models & Entities
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GEOFENCE_MAX_DISTANCE_METERS = exports.TaskPriority = exports.UserRole = void 0;
exports.calculateHaversineDistanceMeters = calculateHaversineDistanceMeters;
exports.checkStoreGeofence = checkStoreGeofence;
var UserRole;
(function (UserRole) {
    UserRole["ADMIN"] = "ADMIN";
    UserRole["SUPERVISOR"] = "SUPERVISOR";
    UserRole["MERCHANDISER"] = "MERCHANDISER";
    UserRole["STORE_STAFF"] = "STORE_STAFF";
})(UserRole || (exports.UserRole = UserRole = {}));
var TaskPriority;
(function (TaskPriority) {
    TaskPriority["LOW"] = "LOW";
    TaskPriority["MEDIUM"] = "MEDIUM";
    TaskPriority["HIGH"] = "HIGH";
    TaskPriority["URGENT"] = "URGENT";
})(TaskPriority || (exports.TaskPriority = TaskPriority = {}));
/**
 * Calculates Haversine distance in meters between two GPS coordinates.
 */
function calculateHaversineDistanceMeters(coord1, coord2) {
    const R = 6371000; // Earth's radius in meters
    const dLat = ((coord2.latitude - coord1.latitude) * Math.PI) / 180;
    const dLon = ((coord2.longitude - coord1.longitude) * Math.PI) / 180;
    const lat1 = (coord1.latitude * Math.PI) / 180;
    const lat2 = (coord2.latitude * Math.PI) / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c);
}
exports.GEOFENCE_MAX_DISTANCE_METERS = 100;
function checkStoreGeofence(userCoord, storeCoord, maxMeters = exports.GEOFENCE_MAX_DISTANCE_METERS) {
    const distance = calculateHaversineDistanceMeters(userCoord, storeCoord);
    const isWithin = distance <= maxMeters;
    return {
        isWithinGeofence: isWithin,
        distanceMeters: distance,
        maxAllowedMeters: maxMeters,
        message: isWithin
            ? `✅ Məkân təsdiqləndi: Mağaza ərazisindəsiniz (${distance}m).`
            : `⚠️ Anti-fraud bloklama: Siz mağaza ərazisində deyilsiniz (Məsafə: ${distance}m). Maksimum icazə verilən məsafə ${maxMeters}m-dir.`,
    };
}
//# sourceMappingURL=domain.js.map