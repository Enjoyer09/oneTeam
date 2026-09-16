#!/usr/bin/env node
/**
 * oneTeam — `testID` contract guard (plan 3.4).
 * ============================================================================
 *
 * WHAT THIS GUARDS
 * ----------------
 * An XCUI test can only tap what it can address, and in React Native that means
 * a `testID`. `mobile/uitests/testids.json` is the contract: it lists the
 * identifiers the Login -> Task -> Photo -> Submit flow needs.
 *
 * Without this guard the failure mode is silent. Rename an identifier in a
 * screen and no test fails here — the future UI test simply times out on an
 * element that is no longer addressable, on a machine that is not this one,
 * long after the change was made. That is the same defect class as a check that
 * cannot fail, so this script checks BOTH directions:
 *
 *   - every id in the manifest must exist in the source
 *   - every `testID` in the source must be in the manifest
 *
 * The second direction is what stops drift: an identifier nobody wrote down is
 * an identifier nobody can rely on.
 *
 * WHY IT SELF-TESTS
 * -----------------
 * A guard that has never been seen to fail is a rumour. `--self-test` copies
 * the mobile tree to a temporary directory, removes one identifier and adds one
 * that is not in the manifest, and requires the checker to report exactly those
 * two problems. If it does not, the guard is broken and exits 2 — not 0.
 *
 * EXIT CODES: 0 clean · 1 findings · 2 the checker itself is broken.
 */

import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..', '..');

const MANIFEST_REL = join('mobile', 'uitests', 'testids.json');
const SCAN_ROOT_REL = 'mobile';

/** Every `*.tsx` file under `root`, as paths relative to `root`. */
function tsxFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'ios' || entry === 'android') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.tsx')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** `testID` values found in the source, mapped to the files that declare them. */
function collectSourceIds(root) {
  const found = new Map();
  // Both React Native spellings: `testID="x"` and `testID={'x'}`.
  const pattern = /testID=(?:"([^"]+)"|\{['"`]([^'"`]+)['"`]\})/g;
  for (const file of tsxFiles(join(root, SCAN_ROOT_REL))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      const id = match[1] ?? match[2];
      const rel = relative(root, file);
      if (!found.has(id)) found.set(id, []);
      found.get(id).push(rel);
    }
  }
  return found;
}

/**
 * Compare the manifest against the source under `root`.
 * Returns `{ missing, unknown, manifestIds, sourceIds }`.
 */
export function check(root) {
  const manifestPath = join(root, MANIFEST_REL);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${MANIFEST_REL}: ${error.message}`, { cause: error });
  }
  if (!Array.isArray(manifest.ids)) {
    throw new Error(`${MANIFEST_REL} has no "ids" array`);
  }

  const manifestIds = manifest.ids.map((entry) => entry.id);
  const sourceIds = collectSourceIds(root);

  const missing = manifestIds.filter((id) => !sourceIds.has(id));
  const unknown = [...sourceIds.keys()]
    .filter((id) => !manifestIds.includes(id))
    .map((id) => ({ id, files: sourceIds.get(id) }));

  return { missing, unknown, manifestIds, sourceIds };
}

function report(root, result) {
  const lines = [];
  for (const id of result.missing) {
    lines.push(`  ✗ MISSING  ${id}  — in the manifest, but no testID in the source`);
  }
  for (const { id, files } of result.unknown) {
    lines.push(`  ✗ UNKNOWN  ${id}  — in ${files.join(', ')}, but not in the manifest`);
  }
  return lines;
}

/** Prove the checker bites, using a throwaway copy of the tree. */
function selfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'oneteam-ui-ids-'));
  const failures = [];
  try {
    // Only what the checker reads. Copying `mobile` wholesale would drag in
    // `node_modules` (hundreds of MB) and make a guard that should take
    // milliseconds take minutes.
    cpSync(join(REPO, 'mobile', 'src'), join(tmp, 'mobile', 'src'), { recursive: true });
    cpSync(join(REPO, 'mobile', 'uitests'), join(tmp, 'mobile', 'uitests'), { recursive: true });
    cpSync(join(REPO, 'mobile', 'Root.tsx'), join(tmp, 'mobile', 'Root.tsx'));

    // 1. Remove an identifier the manifest requires.
    const login = join(tmp, 'mobile', 'src', 'screens', 'LoginScreenUI.tsx');
    const original = readFileSync(login, 'utf8');
    const removed = 'login.submitButton';
    if (!original.includes(removed)) {
      failures.push(`self-test setup is stale: ${removed} is not in LoginScreenUI.tsx`);
    } else {
      writeFileSync(login, original.replace(`testID="${removed}"`, ''));
      const afterRemoval = check(tmp);
      if (!afterRemoval.missing.includes(removed)) {
        failures.push(`removing ${removed} did not make the checker fail`);
      }
    }

    // 2. Add an identifier the manifest does not know about.
    const injected = 'login.surpriseButton';
    const withInjection = original.includes(removed)
      ? original.replace(`testID="${removed}"`, `testID="${removed}" testID="${injected}"`)
      : original;
    writeFileSync(login, withInjection);
    const afterInjection = check(tmp);
    if (!afterInjection.unknown.some((entry) => entry.id === injected)) {
      failures.push(`adding ${injected} did not make the checker report drift`);
    }

    // 3. The real tree must be clean, otherwise the two cases above prove
    //    nothing: a checker that always fails "detects" everything.
    const real = check(REPO);
    if (real.missing.length > 0 || real.unknown.length > 0) {
      failures.push('the real tree is not clean, so the self-test cannot be trusted');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  return failures;
}

function main() {
  const isSelfTest = process.argv.includes('--self-test');

  if (isSelfTest) {
    const failures = selfTest();
    if (failures.length > 0) {
      console.error('\n  ✗ SELF-TEST FAILED — the guard does not bite:\n');
      for (const failure of failures) console.error(`    - ${failure}`);
      console.error('');
      process.exit(2);
    }
    console.log('  ✓ self-test: the guard fails when an identifier is removed or added.');
    process.exit(0);
  }

  let result;
  try {
    result = check(REPO);
  } catch (error) {
    console.error(`\n  ✗ ${error.message}\n`);
    process.exit(2);
  }

  console.log('');
  console.log(
    `  oneTeam testID guard — ${result.manifestIds.length} identifier(s) in the contract, ` +
      `${result.sourceIds.size} in the source`,
  );
  console.log('');

  const lines = report(REPO, result);
  if (lines.length === 0) {
    console.log('  ✓ every identifier in the contract exists, and none exists outside it.');
    console.log('');
    process.exit(0);
  }

  for (const line of lines) console.error(line);
  console.error('');
  console.error('  The Xcode UI test (plan 3.4) can only address what is listed in');
  console.error(`  ${MANIFEST_REL}. Fix the code, or add the identifier to the contract.`);
  console.error('');
  process.exit(1);
}

main();
