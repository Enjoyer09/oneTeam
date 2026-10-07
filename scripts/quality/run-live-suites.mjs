#!/usr/bin/env node
/**
 * Runs every DB-backed suite and reports all of them, not just the first.
 *
 * WHY THIS EXISTS
 * ---------------
 * `test:live` was a `suite && suite && suite` chain. So the first suite that
 * failed ended the run, and everything after it never executed:
 *
 *     npm run test:live   ->  test:panel ✅   test:stores ❌   [12 suites never ran]
 *
 * Measured on 2026-10-05: one failing check in `test:stores` hid 12 suites,
 * including `test:tasks`, `test:device`, `device-revoke`, `device-block` and
 * `bot:test`. GitHub Actions ran this same chain with
 * `continue-on-error: true`, so the whole live tier looked like it was passing
 * while most of it had never been reached — and Actions minutes are exhausted,
 * so that job has not run at all since September either.
 *
 * A gate that stops at the first failure cannot tell you how much is broken,
 * and the suites it skipped are exactly the ones you then have no information
 * about. So: run everything, collect everything, exit non-zero if anything
 * failed.
 *
 * The original chain order is preserved — later suites build on earlier state
 * (the credential the panel suite issues, the device the credential suite
 * enrolls), so this is not a parallel runner.
 *
 * Usage: node scripts/quality/run-live-suites.mjs [--only a,b,c]
 */

import { spawn } from 'node:child_process';

const SUITES = [
  'test:panel',
  'test:stores',
  'test:tasks',
  'test:roles',
  'test:device',
  'test:device-revoke',
  'test:device-block',
  'test:replica',
  'test:refresh',
  'test:write-order',
  'test:flow',
  'test:notify',
  'test:router',
  'bot:test',
  'web:test',
  'mobile:test',
];

const onlyArg = process.argv.indexOf('--only');
const only =
  onlyArg >= 0 && process.argv[onlyArg + 1]
    ? new Set(process.argv[onlyArg + 1].split(',').map((s) => s.trim()))
    : null;

const suites = only ? SUITES.filter((s) => only.has(s)) : SUITES;
if (suites.length === 0) {
  console.error(`No known suites in ${JSON.stringify([...only])}.`);
  process.exit(2);
}

const isTTY = process.stdout.isTTY;
const dim = (s) => (isTTY ? `[2m${s}[0m` : s);
const red = (s) => (isTTY ? `[31m${s}[0m` : s);
const green = (s) => (isTTY ? `[32m${s}[0m` : s);
const yellow = (s) => (isTTY ? `[33m${s}[0m` : s);

/** Last "N passed, M failed" style line a suite printed, for the summary table. */
function tally(output) {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/(\d+)\s+passed,\s*(\d+)\s+failed(?:,\s*(\d+)\s+skipped)?/i);
    if (m) return { passed: +m[1], failed: +m[2], skipped: +(m[3] || 0) };
  }
  return null;
}

const results = [];

for (const suite of suites) {
  process.stdout.write(
    `\n${dim('───')} ${suite} ${dim('─'.repeat(Math.max(0, 56 - suite.length)))}\n`,
  );
  const started = Date.now();
  const outcome = await new Promise((resolve) => {
    const child = spawn('npm', ['run', suite], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      out += d;
      process.stderr.write(d);
    });
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', () => resolve({ code: 127, out }));
  });
  const { code, out: captured } = outcome;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ suite, code, tally: tally(captured), seconds });
}

console.log(`\n${dim('═'.repeat(64))}\n  live suite summary\n${dim('═'.repeat(64))}`);
let failed = 0;
for (const r of results) {
  const mark = r.code === 0 ? green('PASS') : red('FAIL');
  const t = r.tally ? ` ${r.tally.passed} passed, ${r.tally.failed} failed` : ' (no tally)';
  if (r.code !== 0) failed++;
  console.log(`  ${mark}  ${r.suite.padEnd(20)}${dim(t.padEnd(34))}${dim(r.seconds + 's')}`);
}

const totalPassed = results.reduce((n, r) => n + (r.tally?.passed || 0), 0);
const totalFailed = results.reduce((n, r) => n + (r.tally?.failed || 0), 0);
console.log(`${dim('─'.repeat(64))}`);
console.log(
  `  ${results.length} suites, ${totalPassed} checks passed, ${totalFailed} failed, ${failed} suites failed`,
);
if (failed > 0) {
  console.log(yellow(`\n  Every suite above ran. The ${failed} that failed are the ones to read.`));
}
process.exit(failed > 0 ? 1 : 0);
