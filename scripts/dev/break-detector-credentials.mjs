#!/usr/bin/env node
/**
 * Break the detector for the Phase 3.2 credential guards.
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/PRODUCT-PLAN-AZ.md` §7: "Yaşıl test sübut deyil — detektoru pozmaqla
 * yoxlanılır." Two suites guard Phase 3.2:
 *
 *   - `npm run test:credentials` — the credential policy in
 *     `mobile/src/services/credentialStore.ts` and its wiring in `portalApi.ts`;
 *   - `npm run mobile:config` — the static guards in
 *     `scripts/dev/verify-mobile-config.mjs`.
 *
 * Both pass. That on its own says nothing: a suite passes just as happily when
 * the rule it names has been deleted. Each case below deletes ONE rule and
 * insists that the ONE check written for it goes red.
 *
 * THIS IS THE PORT OF A HARNESS THAT USED TO LIVE IN /tmp
 * -------------------------------------------------------
 * The plan recorded the old one as an open debt in two places:
 *
 *     "3.2-nin harness-ı hələ /tmp-dədir və zəifdir (hər hal üçün gözlənti
 *      yoxdur, COMPLETION yoxlaması yoxdur) → aşağıdaki borc cədvəlində açıq iş."
 *
 * It had four holes, and each one is closed here:
 *
 *   1. no per-case EXPECTATION. It printed whatever failed and left the reader
 *      to decide whether the right check had failed. A break that reddens an
 *      unrelated check is not evidence for the guard it was written for, so
 *      every case now names the label it must produce.
 *   2. no COMPLETION check. A patch that breaks the syntax kills the suite
 *      before it prints anything, and "no failing lines" then reads exactly like
 *      "the guard held". Every target must now reach its own summary line.
 *   3. no unique-`find` check. A patch that matched zero times, or twice, was
 *      applied to whichever occurrence came first and reported as a result.
 *   4. no verdict and no exit code, so it could never gate anything. It now
 *      exits non-zero, which is what makes it usable from CI or a pre-commit
 *      hook.
 *
 * Two of the ported cases were ALREADY STALE when this file was written — case
 * E still patched an `App.tsx` that item 3.3 had rewritten, and case L still
 * expected a one-entry `exclude` after a second file was added to it. Both are
 * corrected above, and both are caught by the unique-`find` check below rather
 * than by producing a green line that meant nothing: putting case E's old text
 * back makes this harness report PATCH-FAILED and exit 1. That is the debt being
 * paid.
 *
 * WHAT THIS HARNESS ALSO ADDS: A BASELINE
 * ---------------------------------------
 * Before anything is broken, both targets are run as they stand. If a target is
 * already red, every line it produces afterwards is uninterpretable — a case
 * would "succeed" because the suite was failing all along. A red baseline is
 * reported as a harness failure, not as a result.
 *
 * USAGE
 * -----
 *     npm run test:break:credentials
 *
 * No database and no server: both targets are pure Node, which is why this run
 * takes seconds rather than the 3.3 harness's two minutes.
 *
 * Exits non-zero if the baseline is red, if any break failed to redden its own
 * check, if any patch failed to apply, if any target did not reach its summary
 * line, or if the final restore-and-recheck is not green.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, derived from this file's own location — not hardcoded. */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// npm writes ANSI colour codes into its output, so a suite's own result line has
// to be stripped before it can be compared as text. Matching the escape
// character is the entire purpose of this pattern: without `\x1b` in it there is
// nothing to strip. That is the one thing `no-control-regex` exists to prevent —
// a control character smuggled into a pattern by accident — so this is the rule
// being wrong rather than the code, and it is silenced here rather than for the
// whole file. The other two harnesses carry the same comment for the same
// reason; the rule is the same rule.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

const FILES = {
  creds: 'mobile/src/services/credentialStore.ts',
  api: 'mobile/src/services/portalApi.ts',
  app: 'mobile/src/App.tsx',
  root: 'mobile/Root.tsx',
  tsconfig: 'mobile/tsconfig.json',
};

/** A second importer of the native module, to prove the exclusion cannot widen. */
const WIDEN_FILE = 'mobile/src/services/zz-break-widen.ts';

/**
 * The two things being broken, and how to tell that each one RAN.
 *
 * The completion patterns differ because the suites print different summaries,
 * and `run` differs because they are different npm scripts. Keeping them in one
 * table means a case can only name a target that exists.
 */
const TARGETS = {
  credentials: {
    run: 'test:credentials',
    // `  ✅ 37/37 checks passed`
    completion: /\d+\/\d+ checks passed/,
  },
  config: {
    run: 'mobile:config',
    // `All config checks passed.` or `2 check(s) FAILED.`
    completion: /All config checks passed\.|\d+ check\(s\) FAILED\./,
  },
};

/**
 * One break per guard.
 *
 * `expect` is a substring of the check label that MUST appear on a failure line
 * once the break is in place. `why` says which rule was removed, in the terms of
 * the product rather than of the code.
 */
const CASES = [
  {
    id: 'A',
    target: 'credentials',
    file: 'api',
    why: 'the demo-device-01 default comes back — the defect the suite exists for',
    find: `  const id = currentDeviceId();
  if (id) return id;`,
    replace: `  const id = currentDeviceId() ?? 'demo-device-01'; /*BREAK-A*/
  if (id) return id;`,
    expect: 'deviceId() refuses instead of returning a shared default',
  },
  {
    id: 'B',
    target: 'credentials',
    file: 'creds',
    why: 'the minted identity is never persisted',
    find: `    const minted = this.mint();
    await this.storage.set(DEVICE_ID_KEY, minted);
    return minted;`,
    replace: `    const minted = this.mint();
    /*BREAK-B: the minted identity is not persisted*/
    return minted;`,
    expect: 'it is written to storage, not only held in memory',
  },
  {
    id: 'C',
    target: 'credentials',
    file: 'creds',
    why: 'a storage failure IS cached, so a transient error pins the process',
    find: `        // Do not cache a failure. A transient keychain error would otherwise
        // pin this installation to a broken identity for the life of the
        // process, and every later call would report the first failure.
        this.identity = null;
        throw error;`,
    replace: `        /*BREAK-C: the failure IS cached*/
        throw error;`,
    expect: 'a storage failure is NOT cached',
  },
  {
    id: 'D',
    target: 'credentials',
    file: 'creds',
    why: 'clearing the credential also destroys the identity in storage',
    find: `  async clearDeviceToken(): Promise<void> {
    await this.storage.remove(DEVICE_TOKEN_KEY);
  }`,
    replace: `  async clearDeviceToken(): Promise<void> {
    await this.storage.remove(DEVICE_TOKEN_KEY);
    await this.storage.remove(DEVICE_ID_KEY); /*BREAK-D*/
  }`,
    expect: 'and KEEPS it in STORAGE, so a restart after clearing is still the same device',
  },
  {
    id: 'E',
    target: 'credentials',
    file: 'app',
    why: 'clearing local data reports a count without clearing the queue',
    find: `  async clearLocalData(): Promise<{ queuedItemsCleared: number }> {
    const queuedItemsCleared = await offlineQueueService.clearQueue();
    return { queuedItemsCleared };
  }`,
    replace: `  async clearLocalData(): Promise<{ queuedItemsCleared: number }> {
    /*BREAK-E: the queue is counted but left alone*/
    const queuedItemsCleared = offlineQueueService.getQueue().length;
    return { queuedItemsCleared };
  }`,
    expect: 'clearing local data clears the queue',
  },
  {
    id: 'F',
    target: 'credentials',
    file: 'api',
    why: 'forgetCredential drops it from memory but leaves it in storage',
    find: `export async function forgetCredential(): Promise<void> {
  deviceToken = null;
  await credentialStore.clearDeviceToken();
}`,
    replace: `export async function forgetCredential(): Promise<void> {
  deviceToken = null;
  /*BREAK-F: storage is left alone*/
}`,
    expect: 'forgetCredential clears the credential from memory and from storage',
  },
  {
    id: 'G',
    target: 'credentials',
    file: 'api',
    why: 'the harness overlay ONETEAM_DEVICE_ID is ignored',
    find: `  const fromEnv = (env.ONETEAM_DEVICE_ID || '').trim();
  if (fromEnv) return fromEnv;
  return cachedDeviceId;`,
    replace: `  /*BREAK-G: the harness overlay is ignored*/
  return cachedDeviceId;`,
    expect: 'an explicit ONETEAM_DEVICE_ID is the identity this process uses',
  },
  {
    id: 'H',
    target: 'credentials',
    file: 'creds',
    why: 'an empty credential is accepted, so "enrolled" holds nothing',
    find: `    if (!trimmed) {
      throw new Error('Refusing to store an empty device token.');
    }
`,
    replace: `    /*BREAK-H: an empty credential is accepted*/
`,
    expect: 'an empty credential is refused',
  },
  {
    id: 'I',
    target: 'credentials',
    file: 'creds',
    why: 'the snapshot leaks the enrolment secret it exists to describe',
    find: `      hasEnrollmentSecret: (await this.enrollmentSecret()) !== null,`,
    replace: `      hasEnrollmentSecret: (await this.enrollmentSecret()) !== null,
      leakedSecret: await this.enrollmentSecret(), /*BREAK-I*/`,
    expect: 'the snapshot reports presence without revealing either secret',
  },
  {
    id: 'J',
    target: 'config',
    file: 'root',
    why: 'the app entry stops wiring the keychain into the credential store',
    find: `      if (persistent) credentialStore.useStorage(keychainStore);`,
    replace: `      /*BREAK-J: the keychain is never wired in*/`,
    expect: 'Root.tsx points the credential store at the keychain',
  },
  {
    id: 'K',
    target: 'config',
    file: 'root',
    why: 'the app entry stops restoring the credential at startup',
    find: `        await mobileApp.initializeCredentials();`,
    replace: `        /*BREAK-K: credential not restored*/`,
    expect: 'Root.tsx restores the credential before anything can call the API',
  },
  {
    id: 'L',
    target: 'config',
    file: 'tsconfig',
    why: 'keychain.ts is put back under the type-check',
    // The exclusion list has TWO entries — `queueStorage.ts` must stay excluded,
    // because only `keychain.ts` is the break. An earlier version of this case
    // expected the whole array to hold one entry and silently did not apply
    // after item 3.3 added the second.
    //
    // The marker is a WHOLE-LINE `//` comment, and that is not cosmetic. A
    // tsconfig is JSON, and the config verifier strips whole-line `//` comments
    // and then calls `JSON.parse` — so a trailing `/*BREAK-L*/` on the same line
    // as the value made the file unparseable, the verifier died before printing
    // a single check, and the case reported TARGET-DID-NOT-RUN. The marker must
    // be something the target can still read.
    find: `  "exclude": ["src/services/keychain.ts", "src/services/queueStorage.ts"]`,
    replace: `  // BREAK-L: keychain.ts is back under the type-check
  "exclude": ["src/services/queueStorage.ts"]`,
    expect: 'src/services/keychain.ts is excluded from the type-check',
  },
  {
    id: 'M',
    target: 'config',
    file: 'widen',
    why: 'a second file under src/ starts importing the native module',
    create: `/*BREAK-M: a second native importer, so the exclusion no longer covers them all.*/
import * as SecureStore from 'expo-secure-store';
export const unused = SecureStore;
`,
    expect: 'exactly one file under src/ imports expo-secure-store',
  },
];

// ---------------------------------------------------------------------------

function runTarget(target) {
  try {
    return execFileSync('npm', ['run', '--silent', TARGETS[target].run], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // A failing suite exits non-zero, and its output is on the error. That is
    // the normal path here — a case EXPECTS a failure.
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

/**
 * The labels of the checks that failed.
 *
 * The two suites mark failures differently — `❌ [FAIL] label` from the
 * credential suite, `✗ label  — detail` from the config verifier — so both are
 * matched. Reading only one shape would have reported "no failures" for the
 * other target, which is the silent-pass failure mode this file exists to
 * prevent.
 */
function failingLabels(output) {
  return output
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('✗') || line.includes('[FAIL]'))
    .map((line) =>
      line
        .replace(/.*\[FAIL\]\s*/, '')
        .replace(/^✗\s*/, '')
        .trim(),
    );
}

function read(key) {
  return readFileSync(join(REPO, FILES[key]), 'utf8');
}

function write(key, contents) {
  writeFileSync(join(REPO, FILES[key]), contents);
}

/** Puts every touched file back, and removes the file case M creates. */
function restoreAll(originals) {
  for (const key of Object.keys(FILES)) write(key, originals.get(key));
  if (existsSync(join(REPO, WIDEN_FILE))) rmSync(join(REPO, WIDEN_FILE));
}

// ---------------------------------------------------------------------------
// 0. The baseline.
//
// Without this, a target that is ALREADY red makes every case below look like a
// success — the case "reddened" a check that was failing before it ran. The
// skill calls this calibration: a checker has to be shown clean where the
// verdict is known to be good before its failures mean anything.
// ---------------------------------------------------------------------------
const originals = new Map();
for (const key of Object.keys(FILES)) originals.set(key, read(key));

const baseline = new Map();
let baselineRed = 0;

console.log('Breaking the detector for the Phase 3.2 credential guards');
console.log(`${CASES.length} break cases across ${Object.keys(TARGETS).length} targets.\n`);
console.log('Baseline — both targets as they stand, before anything is broken:');

for (const target of Object.keys(TARGETS)) {
  const output = runTarget(target).replace(ANSI, '');
  const ran = TARGETS[target].completion.test(output);
  const failures = failingLabels(output);
  baseline.set(target, { ran, failures });

  if (ran && failures.length === 0) {
    console.log(`  ✅ ${TARGETS[target].run} is green`);
  } else {
    baselineRed++;
    console.log(`  ❌ ${TARGETS[target].run} is NOT green — nothing below would mean anything`);
    if (!ran) console.log('        it never reached its summary line');
    console.log(`        failures: ${failures.join(' | ') || '<none>'}`);
  }
}

if (baselineRed > 0) {
  console.log('\nBASELINE-RED — fix the target before trusting any break result.');
  restoreAll(originals);
  process.exit(1);
}

console.log('');

let brokeDetector = 0;
let didNotApply = 0;
let didNotRun = 0;
const missed = [];

for (const testCase of CASES) {
  const path = testCase.create ? join(REPO, WIDEN_FILE) : join(REPO, FILES[testCase.file]);
  const original = testCase.create ? '' : originals.get(testCase.file);

  // A `find` that does not appear EXACTLY ONCE is a broken case, not a green
  // one. This is the check that caught cases E and L in this very file.
  if (!testCase.create) {
    const occurrences = original.split(testCase.find).length - 1;
    if (occurrences !== 1) {
      didNotApply++;
      console.log(
        `  ⚠️  ${testCase.id}  PATCH-FAILED — \`find\` appears ${occurrences} time(s) in ` +
          `${FILES[testCase.file]}, expected 1. This case is NOT evidence.`,
      );
      continue;
    }
  }

  const patched = testCase.create
    ? testCase.create
    : original.replace(testCase.find, testCase.replace);

  // The landing proof. A patch that did not reach the file would leave the suite
  // green and be read as "the guard held".
  const marker = (testCase.replace ?? testCase.create).match(/BREAK-[A-Z0-9]+/)?.[0];
  if (!marker || !patched.includes(marker) || (!testCase.create && patched === original)) {
    didNotApply++;
    console.log(`  ⚠️  ${testCase.id}  PATCH-FAILED — the marker is not in the patched file.`);
    continue;
  }

  writeFileSync(path, patched);

  let output;
  try {
    output = runTarget(testCase.target).replace(ANSI, '');
  } finally {
    restoreAll(originals);
  }

  // A patch that broke the syntax proves nothing about the guard: the suite dies
  // before it prints a check, and the absence of failures reads as success.
  if (!TARGETS[testCase.target].completion.test(output)) {
    didNotRun++;
    const tail = output
      .split('\n')
      .filter((line) => line.trim())
      .slice(-2)
      .join(' / ');
    console.log(
      `  ⚠️  ${testCase.id}  TARGET-DID-NOT-RUN — ${TARGETS[testCase.target].run} never reached ` +
        `its summary line, so nothing was exercised.`,
    );
    console.log(`        ${tail.slice(0, 240) || '(empty output)'}`);
    continue;
  }

  const failures = failingLabels(output);
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
restoreAll(originals);

let restoredClean = true;
for (const target of Object.keys(TARGETS)) {
  const output = runTarget(target).replace(ANSI, '');
  const after = failingLabels(output);
  const green = after.length === 0 && TARGETS[target].completion.test(output);
  if (green) {
    console.log(`  ✅ ${TARGETS[target].run} is green again`);
  } else {
    restoredClean = false;
    console.log(`  ❌ ${TARGETS[target].run} did not come back green`);
    if (!TARGETS[target].completion.test(output)) {
      console.log('        it did not reach its summary line');
    }
    console.log(`        failures: ${after.join(' | ') || '<none>'}`);
  }
}

console.log(
  `\n${CASES.length} cases: ${brokeDetector} broke their own check, ` +
    `${missed.length} did not, ${didNotApply} did not apply, ${didNotRun} did not run.`,
);

if (missed.length > 0) {
  console.log('\nHOLES FOUND — the rule is not guarded by the check that claims to:');
  for (const hole of missed) console.log(`  - ${hole.id}: ${hole.why}`);
}

const ok = missed.length === 0 && didNotApply === 0 && didNotRun === 0 && restoredClean;
process.exit(ok ? 0 : 1);
