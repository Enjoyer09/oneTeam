#!/usr/bin/env node
/**
 * Loads a test-only credential BEFORE any suite imports the bot's API client.
 *
 * Plain `.mjs`, not `.ts`, deliberately: `scripts/` is not in the root tsconfig
 * `include` (which covers src/, packages/, apps/), and a .ts file here is a parse
 * error for ESLint's project service — every other file in this directory is
 * .mjs or .cjs for the same reason.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `src/services/portalApi.ts` refuses to start when it has no credential and
 * `NODE_ENV=production`:
 *
 *     oneTeam bot: set ONETEAM_API_TOKEN, or ONETEAM_SERVICE_SIGNING_SECRET +
 *     ONETEAM_SERVICE_USER_ID. Refusing to start with an implicit admin
 *     credential.
 *
 * That guard is correct and stays. The problem is ordering: `import` statements
 * are hoisted, so a suite cannot set an environment variable before its imports
 * run — and `submission.picker.test.ts` imports the bot handler, which imports
 * `portalApi`. So the suite's outcome was decided by the ambient shell rather
 * than by the suite.
 *
 * Measured, not assumed. With `NODE_ENV=production` exported in the shell:
 *
 *     npm run test:bot-picker   -> exit 1, "Refusing to start…"
 *
 * and with the same shell clean:
 *
 *     npm run test:bot-picker   -> exit 0, 25/25 checks pass
 *
 * Note that `dotenv` does NOT rescue this. `.env` does set `NODE_ENV=development`,
 * but `dotenv.config()` does not overwrite a variable that already exists in the
 * environment, so the exported value wins — and the suite silently ran under
 * production rules it was never written for. Every other suite in `test:all`
 * happened to be immune (verified individually); this one was the only one whose
 * import graph reached the credential check.
 *
 * WHAT THIS DOES
 * --------------
 * Runs first, sets a THROWAWAY credential that exists only for the duration of
 * the test process, and requires the module graph afterwards. Nothing here
 * reaches a network: the suites stub `portalApi`'s methods before calling them,
 * which is why they can run without a database at all.
 *
 * This is not the guard being weakened. The guard still refuses a real
 * deployment that has nothing configured — that path is covered by
 * `test:secrets` and by the fact that this file is only ever run as a test
 * script. What is fixed is a test that was reading the operator's shell.
 *
 * Usage:  node ./node_modules/tsx/dist/cli.mjs --import ./scripts/test-credential.mjs <suite>
 */

process.env.ONETEAM_SERVICE_SIGNING_SECRET ||= 'test-only-signing-secret';
process.env.ONETEAM_SERVICE_USER_ID ||= 'usr-test-000';

// Also make the intent explicit, so a suite can never believe it is running
// against a real deployment's rules by accident.
process.env.ONETEAM_TEST_TIER ||= 'in-memory';

// Plain ESM: this file only sets environment variables, so there is nothing to type.
