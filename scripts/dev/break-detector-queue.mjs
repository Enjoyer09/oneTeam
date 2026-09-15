#!/usr/bin/env node
/**
 * Break the detector for plan item 3.3.
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/PRODUCT-PLAN-AZ.md` §7: "Yaşıl test sübut deyil — detektoru pozmaqla
 * yoxlanılır." A suite that passes proves nothing until you break the thing each
 * check guards and watch THAT check go red.
 *
 * TWO FAILURE MODES THIS HARNESS HAD TO BE FIXED FOR (plan item 3.2)
 * ------------------------------------------------------------------
 * The first version of this script lied twice, and both lies made a broken
 * detector look green:
 *
 *   1. It applied patches with `perl -0pi -e 's/\Q…\E/…/'`. Inside `\Q`, a `\n`
 *      is TWO LITERAL CHARACTERS, not a newline — so 7 of 9 multi-line patches
 *      silently did not apply, and the suite read as green.
 *   2. It proved a patch had landed by grepping for a string that also appeared
 *      in a DOC COMMENT. "The patch applied" passed while the code was
 *      untouched.
 *
 * So this version:
 *
 *   - patches with literal `String.replace` and refuses to run a case whose
 *     `find` does not appear EXACTLY ONCE;
 *   - requires every `replace` to carry a unique `BREAK-<ID>` marker, and
 *     asserts the marker is in the patched file before running anything;
 *   - requires the target to reach its SUMMARY LINE, because a patch that breaks
 *     the syntax makes the target die before printing any check — and "no
 *     failing lines" then looks identical to "the suite stayed green". The 3.3
 *     run hit this on Q9 and reported a hole that did not exist;
 *   - treats a patch that did not apply, or a target that did not run, as NOT
 *     EVIDENCE — counted separately and reported as a failure of the harness;
 *   - restores each file after its case, and re-runs everything at the end.
 *
 * USAGE
 * -----
 *     npm run test:break
 *     # or: node scripts/dev/break-detector-queue.mjs
 *
 * Exits non-zero if any break failed to redden its own check, or if any patch
 * failed to apply, or if the final restore-and-recheck is not green.
 *
 * WHY THIS IS IN THE REPO, NOT IN /tmp
 * ------------------------------------
 * It was written in /tmp during the 3.3 work, which made the 3.3 evidence
 * impossible to reproduce. Plan §7 requires proof, and proof that cannot be
 * re-run after a reformat is not proof. It now lives here and is wired to
 * `npm run test:break`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, derived from this file's own location — not hardcoded. */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FILES = {
  queue: 'mobile/src/services/offlineQueue.ts',
  app: 'mobile/src/App.tsx',
  history: 'mobile/src/screens/AuditHistoryScreen.tsx',
  portal: 'mobile/src/services/portalApi.ts',
  tsconfig: 'mobile/tsconfig.json',
  root: 'mobile/Root.tsx',
};

const TARGETS = {
  suite: ['npm', ['run', '--silent', 'test:queue']],
  config: ['npm', ['run', '--silent', 'mobile:config']],
};

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
    id: 'Q1',
    target: 'suite',
    file: 'queue',
    why: 'the refusal to answer before the read is neutered',
    find: `  private assertLoaded(operation: string): void {
    if (this.loaded) return;`,
    replace: `  private assertLoaded(operation: string): void {
    if (true) return; /*BREAK-Q1*/`,
    expect: 'getQueue() throws instead of returning an empty array',
  },
  {
    id: 'Q2',
    target: 'suite',
    file: 'queue',
    why: 'a failed enqueue is left in memory instead of being rolled back',
    find: `    } catch (error) {
      this.queue = this.queue.filter((item) => item.id !== queueItem.id);
      this.notifyChange();`,
    replace: `    } catch (error) {
      /*BREAK-Q2*/
      this.notifyChange();`,
    expect: 'and the item is rolled back out of memory',
  },
  {
    id: 'Q3',
    target: 'suite',
    file: 'queue',
    why: 'a storage failure is swallowed and the audit is reported as queued',
    find: `      const detail = error instanceof Error ? error.message : String(error);
      throw new QueueError(
        \`Audit növbəyə yazıla bilmədi (\${detail}). O, yaddaşda saxlanılmadı — \` +`,
    replace: `      const detail = error instanceof Error ? error.message : String(error);
      if (detail) return queueItem; /*BREAK-Q3*/
      throw new QueueError(
        \`Audit növbəyə yazıla bilmədi (\${detail}). O, yaddaşda saxlanılmadı — \` +`,
    expect: 'a storage failure makes enqueueSubmission throw rather than report success',
  },
  {
    id: 'Q4',
    target: 'suite',
    file: 'queue',
    why: 'the 50 MB limit never fires',
    find: `    if (projectedBytes > MAX_QUEUE_BYTES) {`,
    replace: `    if (false && projectedBytes > MAX_QUEUE_BYTES) { /*BREAK-Q4*/`,
    expect: 'an audit that would push the queue past the limit is refused',
  },
  {
    id: 'Q5',
    target: 'suite',
    file: 'queue',
    why: 'the limit evicts the oldest audit instead of refusing the new one',
    find: `    const next = [...this.queue, queueItem];`,
    replace: `    const next = [queueItem]; /*BREAK-Q5*/`,
    expect: 'the audit already in the queue is STILL there',
  },
  {
    id: 'Q6',
    target: 'suite',
    file: 'queue',
    why: 'the in-flight marker is not written before the upload starts',
    find: `        item.sync_status = 'syncing';
        await this.persist();`,
    replace: `        item.sync_status = 'syncing'; /*BREAK-Q6*/`,
    expect: 'each item was marked `syncing` ON THE DEVICE before its upload started',
  },
  {
    id: 'Q7',
    target: 'suite',
    file: 'queue',
    why: 'the outcome of each upload is not written back',
    find: `        await this.persist();
      }
    } finally {`,
    replace: `        /*BREAK-Q7*/
      }
    } finally {`,
    expect: 'and empty ON THE DEVICE — the removals were written, not just remembered',
  },
  {
    id: 'Q8',
    target: 'suite',
    file: 'queue',
    why: 'the automatic retry cap is ignored',
    find: `    const pending = options.manual
      ? candidates
      : candidates.filter((item) => item.retry_count < MAX_RETRY_ATTEMPTS);`,
    replace: `    const pending = options.manual ? candidates : candidates; /*BREAK-Q8*/`,
    expect: 'an automatic drain does not touch it again',
  },
  {
    id: 'Q9',
    target: 'suite',
    file: 'queue',
    why: 'a manual sync no longer ignores the cap',
    find: `    const pending = options.manual
      ? candidates
      : candidates.filter((item) => item.retry_count < MAX_RETRY_ATTEMPTS);`,
    replace: `    const pending = candidates.filter((item) => item.retry_count < MAX_RETRY_ATTEMPTS); /*BREAK-Q9*/`,
    expect: 'a manual sync retries it anyway',
  },
  {
    id: 'Q10',
    target: 'suite',
    file: 'queue',
    why: 'reconnection no longer triggers a drain',
    find: `      this.autoSyncPromise = this.triggerAutoSync();`,
    replace: `      this.autoSyncPromise = null; /*BREAK-Q10*/`,
    expect: 'a reconnection with a handler drains the queue without being asked',
  },
  {
    id: 'Q11',
    target: 'suite',
    file: 'queue',
    why: 'a missing upload handler becomes a silent no-op again',
    find: `    if (!this.uploadHandler) {`,
    replace: `    if (false) { /*BREAK-Q11*/`,
    expect: 'a reconnection with no upload handler reports `no-handler`',
  },
  {
    id: 'Q12',
    target: 'suite',
    file: 'queue',
    why: 'an interrupted audit is restored as `queued`, ready to be re-uploaded',
    find: `      if (entry.sync_status === 'syncing') {`,
    replace: `      if (false) { /*BREAK-Q12*/`,
    expect: 'the in-flight audit is not restored as `queued`',
  },
  {
    id: 'Q13',
    target: 'suite',
    file: 'queue',
    why: 'a corrupt payload is swallowed without being reported',
    find: `      // A bounded sample, not the whole payload: a corrupt blob can be 50 MB and
      // keeping it in memory to be looked at would be its own problem.
      report.corruption = { length: serialized.length, sample: serialized.slice(0, 200) };
      this.queue = [];
      return report;
    }`,
    replace: `      /*BREAK-Q13*/
      this.queue = [];
      return report;
    }`,
    expect: 'loading a corrupt payload does not throw',
  },
  {
    id: 'Q14',
    target: 'suite',
    file: 'queue',
    why: 'entries that are not queue items are trusted',
    find: `      if (!looksLikeQueueItem(entry)) {`,
    replace: `      if (false) { /*BREAK-Q14*/`,
    expect: 'entries that are not shaped like queue items are dropped, not trusted',
  },
  {
    id: 'Q15',
    target: 'suite',
    file: 'queue',
    why: 'clearing the queue only empties memory',
    find: `    const cleared = this.queue.length;
    this.queue = [];
    await this.persist();`,
    replace: `    const cleared = this.queue.length;
    this.queue = []; /*BREAK-Q15*/`,
    expect: 'and the DEVICE is empty — the clear was written, not just remembered',
  },
  {
    id: 'Q16',
    target: 'suite',
    file: 'queue',
    why: 'a surrogate pair is counted as two bytes instead of four',
    find: `      bytes += 4;
      index++;`,
    replace: `      bytes += 2; /*BREAK-Q16*/`,
    expect: 'utf8Bytes counts an emoji as four, not as two surrogate units',
  },
  {
    id: 'Q17',
    target: 'suite',
    file: 'queue',
    why: 'the storage key is changed, orphaning every queued audit in the field',
    find: `export const QUEUE_STORAGE_KEY = 'oneteam.offlineQueue.v1';`,
    replace: `export const QUEUE_STORAGE_KEY = 'oneteam.queue'; /*BREAK-Q17*/`,
    expect: 'the queue key is the versioned name the adapter uses',
  },
  {
    id: 'Q18',
    target: 'suite',
    file: 'history',
    why: 'nothing registers the upload path with the queue',
    find: `    offlineQueueService.setUploadHandler(uploadQueuedAudit);`,
    replace: `    /*BREAK-Q18*/`,
    expect: 'constructing the coordinator registers an upload handler with the queue',
  },
  {
    id: 'Q19',
    target: 'suite',
    file: 'app',
    why: 'the coordinator reports a clear it never performed',
    find: `    const queuedItemsCleared = await offlineQueueService.clearQueue();`,
    replace: `    const queuedItemsCleared = 0; /*BREAK-Q19*/`,
    expect: 'the coordinator clears the queue and reports the count from the same call',
  },
  {
    id: 'C1',
    target: 'config',
    file: 'tsconfig',
    why: 'the queue adapter is left in the type-check, where it cannot resolve',
    find: `  "exclude": ["src/services/keychain.ts", "src/services/queueStorage.ts"]`,
    replace: `  // BREAK-C1
  "exclude": ["src/services/keychain.ts"]`,
    expect: 'src/services/queueStorage.ts is excluded from the type-check',
  },
  {
    id: 'C2',
    target: 'config',
    file: 'root',
    why: 'the app entry no longer points the queue at AsyncStorage',
    find: `      if (queueIsPersistent) offlineQueueService.useStorage(asyncStorageQueue);`,
    replace: `      /* BREAK-C2 */`,
    expect: 'Root.tsx points the offline queue at AsyncStorage',
  },
  {
    id: 'C3',
    target: 'config',
    file: 'portal',
    why: 'the API address is read through the alias, so Metro never substitutes it',
    find: `    ? process.env.EXPO_PUBLIC_ONETEAM_API_URL
    : undefined;`,
    replace: `    ? env.ONETEAM_API_URL /* BREAK-C3 */
    : undefined;`,
    expect: 'the API address is read as a direct process.env.EXPO_PUBLIC_ONETEAM_API_URL',
  },
  {
    id: 'C4',
    target: 'config',
    file: 'portal',
    why: 'the enrolment secret is given a public name, to be compiled into the bundle',
    find: `    env.ONETEAM_ENROLLMENT_SECRET ??`,
    replace: `    process.env.EXPO_PUBLIC_ONETEAM_ENROLLMENT_SECRET ?? /* BREAK-C4 */`,
    expect: 'no credential has a public (EXPO_PUBLIC_) name',
  },
];

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * What a target prints when it RAN TO COMPLETION.
 *
 * This is the harness's third failure mode, and the break run for 3.3 found it.
 * The first two were a patch that silently did not apply and a marker satisfied
 * by a doc comment. This one is subtler: a patch that produces a SYNTAX error
 * makes the target die before printing a single check, so there are no `[FAIL]`
 * lines at all — and "no failing lines" is indistinguishable from "the suite
 * stayed green".
 *
 * It surfaced on Q9, whose first replacement produced
 * `false ? options.manual ? candidates : …;` and a transform error. The harness
 * reported a hole in the detector; there was none. A false hole is not harmless:
 * it spends the attention that a real hole needs, and it teaches you to distrust
 * the report.
 *
 * So a case counts as evidence only if the target reached its summary line.
 */
const COMPLETION = {
  suite: /\d+ checks: \d+ passed/,
  config: /All config checks passed\.|\d+ check\(s\) FAILED\./,
};

function runTarget(name) {
  const [command, args] = TARGETS[name];
  try {
    const out = execFileSync(command, args, {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out;
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

/** The labels of the checks that failed, with the colour codes removed. */
function failingLabels(output) {
  return output
    .replace(ANSI, '')
    .split('\n')
    .filter((line) => line.includes('[FAIL]') || line.trimStart().startsWith('✗'))
    .map((line) => line.replace(/.*(\[FAIL\]|✗)\s*/, '').trim());
}

function read(file) {
  return readFileSync(join(REPO, FILES[file]), 'utf8');
}

function write(file, contents) {
  writeFileSync(join(REPO, FILES[file]), contents);
}

// ---------------------------------------------------------------------------

const originals = new Map();
for (const key of Object.keys(FILES)) originals.set(key, read(key));

let brokeDetector = 0;
let didNotApply = 0;
let didNotRun = 0;
let missed = [];

console.log('Breaking the detector for plan item 3.3');
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
  // green and be read as "the guard held" — which is exactly how the first
  // version of this harness lied.
  const marker = testCase.replace.match(/BREAK-[A-Z0-9]+/)?.[0];
  if (!marker || !patched.includes(marker) || patched === original) {
    didNotApply++;
    console.log(`  ⚠️  ${testCase.id}  PATCH-FAILED — the marker is not in the patched file.`);
    continue;
  }

  write(testCase.file, patched);

  let output;
  try {
    output = runTarget(testCase.target);
  } finally {
    write(testCase.file, original);
  }

  const clean = output.replace(ANSI, '');

  // A patch that broke the file proves nothing about the guard. See COMPLETION.
  if (!COMPLETION[testCase.target].test(clean)) {
    didNotRun++;
    const tail = clean
      .split('\n')
      .filter((line) => line.trim())
      .slice(-2)
      .join(' / ');
    console.log(
      `  ⚠️  ${testCase.id}  TARGET-DID-NOT-RUN — the patched file never reached the summary ` +
        `line, so nothing was exercised. This case is NOT evidence.`,
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

const suiteOutput = runTarget('suite').replace(ANSI, '');
const configOutput = runTarget('config').replace(ANSI, '');
const afterSuite = failingLabels(suiteOutput);
const afterConfig = failingLabels(configOutput);

const completed = COMPLETION.suite.test(suiteOutput) && COMPLETION.config.test(configOutput);
const restoredClean = afterSuite.length === 0 && afterConfig.length === 0 && completed;

if (!restoredClean) {
  console.log(`  ❌ the restore did not come back green`);
  if (!completed) console.log('        a target did not reach its summary line');
  console.log(`        suite failures: ${afterSuite.join(' | ') || '<none>'}`);
  console.log(`        config failures: ${afterConfig.join(' | ') || '<none>'}`);
} else {
  console.log('  ✅ the restored tree is green in both targets');
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
