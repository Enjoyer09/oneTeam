#!/usr/bin/env node
/**
 * Break the detector for the device revocation route.
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/PRODUCT-PLAN-AZ.md` §7: "Yaşıl test sübut deyil — detektoru pozmaqla
 * yoxlanılır." `test:device-revoke` passes, and that on its own says nothing: a
 * suite passes just as happily when the guard it names has been deleted. This
 * harness deletes each guard in turn and insists that the ONE check written for
 * it goes red.
 *
 * WHY THIS ONE IS HARDER THAN THE QUEUE HARNESS
 * ---------------------------------------------
 * `break-detector-queue.mjs` patches TypeScript and runs it through `tsx`, so the
 * patch takes effect immediately. This suite talks HTTP to a COMPILED API, so
 * every case has to rebuild the server, start it on a port of its own, run the
 * suite against that server, and stop it again. That is why the run is slower —
 * and it is not a reason to skip the step.
 *
 * The rules carried over from the 3.2/3.3 harnesses, each of which exists
 * because an earlier version lied:
 *
 *   - a `find` that does not appear EXACTLY ONCE is a PATCH-FAILED case, not a
 *     green one;
 *   - every patch carries a `BREAK-<ID>` marker and the marker must be in the
 *     patched file before anything runs;
 *   - the target must reach its SUMMARY LINE, because a patch that breaks the
 *     syntax makes the suite die before printing a check, and "no failing lines"
 *     then looks exactly like "the guard held";
 *   - a patch that did not apply, or a target that did not run, is NOT EVIDENCE
 *     — counted separately and reported as a harness failure;
 *   - every file is restored after its case and everything is re-run at the end.
 *
 * USAGE
 * -----
 *     DATABASE_URL=postgres://... npm run test:break:device-revoke
 *
 * Exits non-zero if any break failed to redden its own check, if any patch
 * failed to apply, if any target did not run, or if the final restore-and-recheck
 * is not green.
 */

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// `pg` is CommonJS, so this file has to take its default export and destructure.
// `import { Client } from 'pg'` throws at load time with a message that names
// the fix, which is how this was found — the harness had never run at all.
const { Client } = pg;

/** Repo root, derived from this file's own location — not hardcoded. */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A port of its own, so a development server on 3001 is not disturbed. */
const PORT = Number(process.env.ONETEAM_BREAK_PORT || 3199);
const API_URL = `http://127.0.0.1:${PORT}`;

const DATABASE_URL = process.env.DATABASE_URL || '';

const FILES = {
  controller: 'apps/api/src/modules/portal/panel-auth.controller.ts',
  postgres: 'packages/database/src/postgres.ts',
  guard: 'apps/api/src/common/auth/auth.guard.ts',
};

const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * The line every suite run must reach before its output counts as evidence.
 *
 * Without this, a patch that produces a syntax error kills the suite before it
 * prints anything, and the absence of failing checks is read as success. The
 * 3.3 run reported exactly that hole before this was added.
 */
const COMPLETION = /\d+ passed, \d+ failed, \d+ skipped/;

/**
 * One break per guard.
 *
 * `expect` is a substring of the check label that MUST appear on a failure line
 * once the break is in place. Matching the label rather than "something failed"
 * is the point: a break that reddens an unrelated check has not tested the guard
 * it was written for.
 */
const CASES = [
  {
    id: 'D1',
    file: 'controller',
    why: 'the role gate on the revoke route is removed',
    find: `    const principal = requireSupervisor(request);
    const target = String(deviceId ?? '').trim();`,
    replace: `    const principal = getPrincipal(request); /*BREAK-D1*/
    const target = String(deviceId ?? '').trim();`,
    expect: 'and a merchandiser cannot cut a device off',
  },
  {
    id: 'D2',
    file: 'postgres',
    why: 'the revocation runs but revokes nothing, and still reports one row',
    find: `  const result = await pool.query(
    \`UPDATE device_tokens
        SET revoked_at = now()
      WHERE device_id = $1
        AND revoked_at IS NULL\`,
    [deviceId],
  );
  return result.rowCount ?? 0;`,
    replace: `  const result = await pool.query('SELECT 1 WHERE $1 IS NOT NULL', [deviceId]); /*BREAK-D2*/
  return result.rowCount ?? 0;`,
    expect: 'THE DEVICE CREDENTIAL STOPS WORKING',
  },
  {
    id: 'D3',
    file: 'controller',
    why: 'revoking an already-revoked device is reported as success',
    find: `    if (revoked === 0) {`,
    replace: `    if (false) { /*BREAK-D3*/`,
    expect: 'revoking it a second time is not reported as success',
  },
  {
    id: 'D4',
    file: 'controller',
    why: 'the act is not recorded in the audit trail',
    find: `      action: 'DEVICE_CREDENTIAL_REVOKED',`,
    replace: `      action: 'DEVICE_CREDENTIAL_REVOKED_BROKEN', /*BREAK-D4*/`,
    expect: 'the act is in the audit trail',
  },
  {
    id: 'D5',
    file: 'controller',
    why: 'the list hides revoked devices, so the record does not survive',
    find: `    const rows = await db.listDeviceTokens(true);`,
    replace: `    const rows = await db.listDeviceTokens(false); /*BREAK-D5*/`,
    expect: 'the device is still listed, so the record survives',
  },
  {
    id: 'D6',
    file: 'guard',
    why: 'a device credential is allowed onto the panel routes',
    find: `    if (principal.via === 'device') {`,
    replace: `    if (false) { /*BREAK-D6*/`,
    expect: 'and is refused as a panel-route problem, not as a role problem',
  },
];

// ---------------------------------------------------------------------------
// The server under test
// ---------------------------------------------------------------------------

function buildServer() {
  for (const script of ['build:packages', 'api:build']) {
    try {
      execFileSync('npm', ['run', '--silent', script], {
        cwd: REPO,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      return `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
  }
  return null;
}

async function waitForHealth(budgetMs = 20000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_URL}/api/health`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Starts the API with the patch in place and returns a stop function.
 *
 * The server is a child of this process, so it is killed with the case rather
 * than left listening — a stray server on the break port would make the NEXT
 * case run against the previous case's code, which is the worst possible
 * outcome for a harness whose whole job is attribution.
 */
async function startServer() {
  const child = spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL,
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  child.stdout.on('data', (chunk) => (log += chunk));
  child.stderr.on('data', (chunk) => (log += chunk));

  const healthy = await waitForHealth();
  return {
    healthy,
    log,
    stop: () =>
      new Promise((done) => {
        child.once('exit', () => done());
        child.kill('SIGTERM');
        setTimeout(() => {
          child.kill('SIGKILL');
          done();
        }, 4000);
      }),
  };
}

function runSuite() {
  try {
    return execFileSync('npm', ['run', '--silent', 'test:device-revoke'], {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        ...process.env,
        ONETEAM_API_URL: API_URL,
        DATABASE_URL,
        NO_PROXY: 'localhost,127.0.0.1',
        no_proxy: 'localhost,127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

/**
 * Clears keys this suite left behind.
 *
 * A case whose break makes the suite fail early can skip its own cleanup, and a
 * leftover live key LOCKS the panel — after which the next case cannot mint the
 * keys it needs, skips every check, and reports TARGET-DID-NOT-RUN. The harness
 * would then be measuring its own mess. Only rows this suite labels are touched.
 */
async function clearLeftoverKeys() {
  if (!DATABASE_URL) return;
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query(
    `UPDATE panel_tokens SET revoked_at = now()
      WHERE revoked_at IS NULL AND label LIKE 'device-revoke suite%'`,
  );
  await client.end();
}

/** The labels of the checks that failed, with the colour codes removed. */
function failingLabels(output) {
  return output
    .replace(ANSI, '')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('✗'))
    .map((line) => line.replace(/.*✗\s*/, '').trim());
}

function read(file) {
  return readFileSync(join(REPO, FILES[file]), 'utf8');
}

function write(file, contents) {
  writeFileSync(join(REPO, FILES[file]), contents);
}

// ---------------------------------------------------------------------------

if (!DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set. This harness runs a real API against a real\n' +
      'database, because the suite it breaks does. Set it and run again.',
  );
  process.exit(1);
}

const originals = new Map();
for (const key of Object.keys(FILES)) originals.set(key, read(key));

let brokeDetector = 0;
let didNotApply = 0;
let didNotRun = 0;
const missed = [];

console.log('Breaking the detector for the device revocation route');
console.log(`${CASES.length} break cases, each expecting its OWN check to go red.\n`);

for (const testCase of CASES) {
  const original = originals.get(testCase.file);
  const occurrences = original.split(testCase.find).length - 1;

  if (occurrences !== 1) {
    didNotApply++;
    console.log(
      `  ⚠️  ${testCase.id}  PATCH-FAILED — \`find\` appears ${occurrences} time(s), expected 1. ` +
        `This case is NOT evidence.`,
    );
    continue;
  }

  const patched = original.replace(testCase.find, testCase.replace);

  // The landing proof. A patch that did not reach the file would leave the suite
  // green and be read as "the guard held".
  const marker = testCase.replace.match(/BREAK-[A-Z0-9]+/)?.[0];
  if (!marker || !patched.includes(marker) || patched === original) {
    didNotApply++;
    console.log(`  ⚠️  ${testCase.id}  PATCH-FAILED — the marker is not in the patched file.`);
    continue;
  }

  write(testCase.file, patched);

  let output;
  let server;
  try {
    const buildError = buildServer();
    if (buildError) {
      didNotRun++;
      console.log(`  ⚠️  ${testCase.id}  BUILD-FAILED — the patched tree does not compile.`);
      console.log(
        `        ${buildError.split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 240)}`,
      );
      continue;
    }

    await clearLeftoverKeys();
    server = await startServer();
    if (!server.healthy) {
      didNotRun++;
      console.log(`  ⚠️  ${testCase.id}  SERVER-DID-NOT-START — nothing was exercised.`);
      console.log(
        `        ${server.log.split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 240)}`,
      );
      continue;
    }

    output = runSuite();
  } finally {
    if (server) await server.stop();
    write(testCase.file, original);
  }

  const clean = output.replace(ANSI, '');

  // A patch that broke the file proves nothing about the guard. See COMPLETION.
  if (!COMPLETION.test(clean)) {
    didNotRun++;
    const tail = clean
      .split('\n')
      .filter((line) => line.trim())
      .slice(-2)
      .join(' / ');
    console.log(
      `  ⚠️  ${testCase.id}  TARGET-DID-NOT-RUN — the suite never reached its summary line, ` +
        `so nothing was exercised. This case is NOT evidence.`,
    );
    console.log(`        ${tail.slice(0, 240)}`);
    continue;
  }

  const failures = failingLabels(clean);
  const hit = failures.some((label) => label.includes(testCase.expect));

  if (hit) {
    brokeDetector++;
    console.log(`  ✅ ${testCase.id}  ${testCase.why}`);
  } else {
    missed.push({ id: testCase.id, why: testCase.why, expect: testCase.expect, failures });
    console.log(`  ❌ ${testCase.id}  ${testCase.why}`);
    console.log(`        expected a failure matching: ${testCase.expect}`);
    console.log(
      `        actual failures: ${failures.join(' | ') || '<none — the suite stayed green>'}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Restore, and prove it.
//
// A harness that leaves a patched file behind is worse than no harness: the next
// run would be testing the broken code and reporting green.
// ---------------------------------------------------------------------------
console.log('\nRestoring and re-checking…');
for (const key of Object.keys(FILES)) write(key, originals.get(key));

const buildError = buildServer();
let restoredClean = false;
if (buildError) {
  console.log('  ❌ the restored tree does not compile');
  console.log(
    `        ${buildError.split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 240)}`,
  );
} else {
  await clearLeftoverKeys();
  const server = await startServer();
  if (!server.healthy) {
    console.log('  ❌ the restored server did not start');
    console.log(
      `        ${server.log.split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 240)}`,
    );
  } else {
    const output = runSuite().replace(ANSI, '');
    await server.stop();
    const after = failingLabels(output);
    restoredClean = after.length === 0 && COMPLETION.test(output);
    if (restoredClean) {
      console.log('  ✅ the restored tree is green');
    } else {
      console.log('  ❌ the restore did not come back green');
      if (!COMPLETION.test(output)) console.log('        the suite did not reach its summary line');
      console.log(`        failures: ${after.join(' | ') || '<none>'}`);
    }
  }
}

console.log(
  `\n${CASES.length} cases: ${brokeDetector} broke their own check, ` +
    `${missed.length} did not, ${didNotApply} did not apply, ${didNotRun} did not run.`,
);

if (missed.length > 0) {
  console.log('\nHOLES FOUND — the guard is not guarded by the check that claims to:');
  for (const hole of missed) console.log(`  - ${hole.id}: ${hole.why}`);
}

const ok = missed.length === 0 && didNotApply === 0 && didNotRun === 0 && restoredClean;
process.exit(ok ? 0 : 1);
