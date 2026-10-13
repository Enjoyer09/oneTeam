/**
 * Is this GPS fix recent enough to prove where someone is *now*?
 *
 * WHY THIS EXISTS
 * ---------------
 * `field.service.ts` decided "this submission carries a real fix" by asking
 * whether two numbers exist:
 *
 *     const hasRealFix =
 *       typeof payload.latitude === 'number' && typeof payload.longitude === 'number';
 *
 * That answers "is there a coordinate", not "is it current". Nothing upstream
 * can close the gap, because no client sends a timestamp at all — there is no
 * `locatedAt`, `capturedAt` or equivalent anywhere in the repository. The pair is
 * therefore an untimed claim, and a device that acquired a fix once can replay
 * those same two numbers hours later, from anywhere.
 *
 * The geofence downstream does not help. A replayed fix that was inside the
 * radius when it was taken is still inside the radius when it is replayed; the
 * coordinates pass, and only the age is wrong. Age is the entire signal.
 *
 * WHY A STALE FIX IS REFUSED RATHER THAN DOWNGRADED
 * -----------------------------------------------
 * The no-fix path already exists: `field.service.ts` files the audit against the
 * store's own coordinates and marks it `locationUnverified`. Sending a stale fix
 * down that same path would file it inside the geofence *by construction* and
 * pass — manufacturing a passing result out of no evidence. A worker who is
 * somewhere else must be told so, not quietly recorded as present.
 *
 * WHY FOUR MINUTES
 * -----------------
 * This is not a geofence radius problem — the radius is 100 m and unchanged. It
 * is a "did they just take this reading" problem, and the shortest plausible
 * window for that is a normal network round trip plus a photo upload, which the
 * presigned path already makes multi-second. Four minutes is far above that and
 * far below the hours-scale replay this closes, so it does not reject a worker
 * who is genuinely standing in the shop with a slow connection.
 *
 * Clients that send no timestamp are NOT treated as fresh. An absent timestamp
 * has no age, so it cannot be shown to be current, and the pre-existing
 * `locationUnverified` escape hatch exists precisely for clients that cannot
 * produce one — claiming it through would make the field pointless.
 */

import { clock } from '@oneteam/types';

/** How old a fix may be and still count as evidence of a present location. */
export const MAX_FIX_AGE_MS = 4 * 60 * 1000;

/**
 * Clock skew a client may legitimately have before its timestamp is suspicious.
 *
 * Without this, a device whose clock is a minute fast is treated as having sent
 * a future fix, which is a different failure and would be refused by the same
 * predicate. The tolerance is small on purpose: it exists for drift, not for a
 * client minting an eternal fix by reporting tomorrow.
 */
const MAX_CLOCK_SKEW_MS = 60 * 1000;

/**
 * True when `timestamp` is recent enough to be evidence of where the device is
 * now, and is not so far in the future that the device's clock cannot be
 * trusted.
 *
 * Anything unparseable or absent is not fresh. "No timestamp" is a distinct case
 * from "stale timestamp" and callers handle them differently, so it is answered
 * here rather than by defaulting either way.
 */
export function isFixFresh(timestamp: string | null | undefined, now: Date = clock.now()): boolean {
  if (!timestamp) return false;

  const taken = Date.parse(timestamp);
  if (Number.isNaN(taken)) return false;

  const age = now.getTime() - taken;

  // A fix claimed to be from the future is refused rather than clamped to "now":
  // a device that cannot tell the time cannot date its evidence.
  if (age < -MAX_CLOCK_SKEW_MS) return false;

  // Inclusive, so exactly at the limit is still accepted.
  return age <= MAX_FIX_AGE_MS;
}
