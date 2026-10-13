/**
 * oneTeam — the clock, in one place
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * A bare `new Date()` reads the wall clock at the call site and nothing can
 * replace it, so any behaviour that depends on "now" is untestable: you cannot
 * make a token look expired, a GPS fix look stale, or a record look old. The
 * repository has a lint rule for exactly this — `no-restricted-syntax` on a
 * zero-argument `new Date()` — and this module is the ONE place allowed to trip
 * it. Every other call site goes through `clock.now()`.
 *
 * The seam is a mutable object on purpose. A test that needs a fixed time
 * assigns `clock.now = () => new Date('2026-01-01T00:00:00Z')` in setup and
 * restores it in teardown; production never assigns it.
 *
 * `Date.now()` — the millisecond number — is deliberately NOT restricted. It is
 * already controllable with fake timers, so this module exists for the sites
 * that need a real `Date` object or an ISO string, not for those.
 */

export const clock = {
  /**
   * The current time. Never call `new Date()` directly; call this, so the one
   * seam a test has to replace stays a single line.
   */
  // eslint-disable-next-line no-restricted-syntax -- the single site allowed to read the wall clock; every other call site goes through clock.now().
  now: (): Date => new Date(),
};
