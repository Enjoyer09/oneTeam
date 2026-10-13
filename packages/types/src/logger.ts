/**
 * One log seam, shared by the API, the bot and the database package — the same
 * idea as `clock.ts` next to it: a single place a test can replace, so a
 * business-logic module reaches the process's stdout through something it
 * declares rather than through a global it happens to find.
 *
 * The eslint config allows `console.warn` and `console.error` everywhere (a
 * warning and an error are the console's own job) and restricts `console.log`.
 * This module is the one place `log.info` is allowed to reach `console.log`;
 * every other call site goes through `log.info(...)`.
 *
 * `console.error` is not routed through here on purpose. An error path that
 * depends on an injectable seam is an error path a misconfigured test can
 * swallow; the repo's rule already permits it directly, and it stays direct.
 */

export const log = {
  // eslint-disable-next-line no-console -- the one implementation behind log.info().
  info: (message: string): void => console.log(message),
};
