/**
 * The clock, for the portal — the same seam `@oneteam/types` exports for the
 * API and the bot, kept local because `web/` does not declare that workspace
 * package as a dependency and a build must not depend on hoisting.
 *
 * The repository restricts a zero-argument `new Date()` (eslint.config.mjs,
 * `no-restricted-syntax`) because it reads the wall clock where nothing can
 * replace it. This module is the portal's one such site; everything else calls
 * `clock.now()`, which a test can point at a fixed instant.
 */
export const clock = {
  // eslint-disable-next-line no-restricted-syntax -- the single portal site allowed to read the wall clock.
  now: (): Date => new Date(),
};
