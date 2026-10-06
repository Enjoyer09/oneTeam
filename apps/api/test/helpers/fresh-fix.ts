/**
 * A GPS fix that is fresh RIGHT NOW.
 *
 * The API refuses a submission whose fix is older than a few minutes
 * (`gps-freshness.ts`), so a test payload has to say when its fix was taken or
 * it tests the staleness check instead of what it means to. Generated per call
 * rather than a module constant, because a constant would go stale itself and
 * the suite would start failing for the wrong reason weeks from now.
 */
export const FRESH_FIX_AT = (): string => new Date().toISOString();
