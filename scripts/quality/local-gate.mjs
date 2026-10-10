#!/usr/bin/env node
/**
 * oneTeam — local CI gate (the replacement for GitHub Actions)
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * `.github/workflows/ci.yml` has failed on every push since 2026-09-20. The
 * cause is not the workflow: GitHub reports, per run, "The job was not started
 * because recent account payments have failed or your spending limit needs to
 * be increased." The repository is PRIVATE, so Actions minutes are metered, and
 * the account is out of credit.
 *
 * We are not paying for it. So this file runs the same checks locally, and
 * `.githooks/pre-push` refuses to push until they pass. The pipeline is the
 * authority on whether code is mergeable — that principle does not require a
 * GitHub-hosted runner, only that the checks actually run before the change
 * leaves the machine.
 *
 * Two checks are genuinely out of reach locally and are reported as SKIPPED
 * rather than silently passing — see SKIPPED below.
 *
 * `--fast` skips only the slowest step (`test:all`). Everything else — the
 * secret scan, types, lint, formatting, the mobile type check — always runs.
 *
 *   npm run gate         # the full local gate (what pre-push runs)
 *   npm run gate:fast    # everything except test:all
 */
import { spawn } from 'node:child_process';

const FAST = process.argv.includes('--fast');

/** Each step records why it exists, so a red result explains itself. */
const STEPS = [
  {
    name: 'Scan tracked files for committed credentials',
    cmd: ['npm', 'run', 'test:secrets'],
    because: 'a leaked credential in git history is unremovable without a rewrite',
  },
  {
    name: 'Portal silent-success guard',
    cmd: ['node', 'scripts/quality/portal-silent-success.test.mjs'],
    because: 'a write that fails must not be reported to the user as a success',
  },
  {
    name: 'Route authentication coverage',
    cmd: ['node', 'scripts/quality/auth-guard-coverage.test.mjs'],
    because:
      'AuthGuard is not global; a route is protected only where a decorator says so, and a new route that ships without one is a hole the runtime suites never see. This walks every controller and fails on any route that is neither guarded nor a named, justified exemption.',
  },
  {
    name: 'Mobile config check',
    cmd: ['npm', 'run', 'mobile:config'],
    because: 'the native project references paths that must exist before Xcode is opened',
  },
  {
    name: 'UI test-id contract',
    cmd: ['npm', 'run', 'test:ui-ids'],
    because: 'the iOS UI tests address elements by these ids; a rename breaks them silently',
  },
  {
    name: 'Mobile type check',
    cmd: ['npm', 'run', 'mobile:check'],
    because: 'mobile/ is not covered by the root tsconfig',
  },
  { name: 'Lint', cmd: ['npm', 'run', 'lint'], because: 'warnings are allowed; errors are not' },
  {
    name: 'Type check',
    cmd: ['npm', 'run', 'type-check'],
    because: 'a commit that does not compile is the cheapest defect to catch and the worst to ship',
  },
  {
    name: 'Web portal type check',
    cmd: ['npm', 'run', 'web:check'],
    because:
      'web/ is NOT in the root tsconfig — without this its types are never checked by any gate',
  },
  {
    name: 'Web portal production build',
    cmd: ['npm', 'run', 'web:build'],
    because:
      'type check passes on code that cannot bundle. Measured: a broken vite plugin plugin-hook makes web:check exit 0 and web:build exit 1, so without this step a portal that ships a blank page passes every gate. GitHub Actions checked this in its own `build` job — which cannot run on a private repo with exhausted Actions minutes, so the check that would have caught it has never actually run.',
    slow: true,
  },
  {
    name: 'Format check',
    cmd: ['npm', 'run', 'format:check'],
    because: 'Prettier disagreements create diff noise that hides real changes',
  },
  {
    name: 'Dependency audit',
    cmd: ['npm', 'audit', '--audit-level=high'],
    because: 'a high-severity advisory in a shipped dependency is an incident waiting',
  },
  {
    name: 'Test suite',
    cmd: ['npm', 'run', 'test:all'],
    because: 'the suites that encode the anti-fraud and state-machine rules',
    slow: true,
  },
];

/** Out of reach locally. Reported as SKIPPED, never as passed. */
const SKIPPED = [
  {
    name: 'DB-backed live suites (test:live)',
    why: 'needs a running PostgreSQL. Start one and run `npm run test:live` yourself.',
  },
  {
    name: 'iOS UI tests (xcodebuild)',
    why: 'needs macOS + Xcode + a simulator. Run via `npm run mobile:ios`.',
  },
];

const steps = FAST ? STEPS.filter((s) => !s.slow) : STEPS;

function run([cmd, ...args]) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => resolve({ code, output }));
    child.on('error', (e) => resolve({ code: 127, output: String(e) }));
  });
}

/**
 * Runs every step in order and reports.
 *
 * Steps run sequentially, not in parallel: they all read the same working tree,
 * and two `tsc` processes racing over one `dist/` is a flaky gate that teaches
 * people to retry it — which is worse than a slow gate.
 */
async function main() {
  console.log('══════════════════════════════════════════════════════════');
  console.log(' oneTeam — local CI gate');
  console.log(` ${FAST ? 'fast mode: skipping the slowest step (test:all)' : 'full mode'}`);
  console.log('══════════════════════════════════════════════════════════\n');

  const results = [];
  for (const [i, step] of steps.entries()) {
    const label = `${String(i + 1).padStart(2)}/${steps.length} ${step.name}`;
    process.stdout.write(`⏳ ${label} … `);
    const started = Date.now();
    const { code, output } = await run(step.cmd);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const ok = code === 0;
    results.push({ step, ok, secs, output });
    console.log(ok ? `✅ ${secs}s` : `❌ FAILED (${secs}s)`);
    if (!ok) console.log(`      why: ${step.because}\n`);
  }

  console.log('\n──────────────────────────────────────────────────────────');
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(` ${failed.length} of ${steps.length} steps FAILED\n`);
    for (const f of failed) {
      console.log(`── ${f.step.name} ──`);
      console.log(tail(f.output));
      console.log('');
    }
    console.log('NOT PUSHED. Nothing left this machine.');
    process.exit(1);
  }

  console.log(` ✅ all ${steps.length} steps passed\n`);
  console.log(' Skipped (cannot run here — NOT counted as passing):');
  for (const s of SKIPPED) console.log(`   • ${s.name}\n     ${s.why}`);
  process.exit(0);
}

main();
/**
 * The tail of a failed step. A full failure log is thousands of lines and the
 * line that matters is usually near the end; showing everything teaches people
 * to skim past the one sentence that would have said what broke.
 */
function tail(output, lines = 25) {
  const all = output.trimEnd().split('\n');
  return all.length <= lines ? all.join('\n') : all.slice(-lines).join('\n');
}
