#!/usr/bin/env node
/**
 * Tests for scripts/quality/secret-scan.mjs.
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The scanner was narrowed so that CI could stop dying on 13 false positives.
 * Narrowing a security detector is precisely how a scanner gets blinded: every
 * exemption added is a hole, and a hole you did not measure is a hole you will
 * discover from an incident report.
 *
 * So this suite asserts BOTH directions, and the second one is the important
 * one:
 *
 *   1. NEGATIVE CONTROLS — the 13 known false positives no longer fire.
 *   2. POSITIVE CONTROLS — every NEAR MISS still fires: a REMOTE database URL, a
 *      compose-service host, a base64 blob that is not part of an image, and a
 *      token with a real-looking prefix and no giveaway word.
 *
 * A suite that only did (1) would pass on a scanner that reports nothing at all.
 * That is the failure mode this file exists to prevent, and it is the same
 * mistake as the suite that called its own handler and never touched the router.
 *
 * WHY EVERY FIXTURE IS BUILT FROM FRAGMENTS
 * -----------------------------------------
 * This file is itself scanned, and that is on purpose. The first version stored
 * the fixtures as whole literals; the local scan passed because the file was not
 * yet staged, and once it was committed the scanner flagged its OWN test corpus
 * — 11 CRITICAL findings, and CI went red again.
 *
 * The fixtures cannot simply be exempted by path. A path exemption would stop
 * this file being scanned at all, so a real credential pasted in here "just to
 * test" would be missed — and a scanner's own directory is the LAST place that
 * should be a blind spot.
 *
 * Instead every fixture is assembled at runtime by `j()` from fragments that are
 * each too short, or too incomplete, to match any detector. The file therefore
 * stays fully scannable, and the value the scanner actually sees — written to a
 * temporary file — is byte-for-byte what a whole literal would have produced.
 *
 * The fragments are also why this file cannot show you a whole credential in a
 * comment: reproducing one is exactly what made the scanner report itself.
 *
 * HOW IT RUNS
 * -----------
 * Cases are written to a temporary directory OUTSIDE the repository and passed
 * to the scanner with `--files`, so the scan sees exactly the cases and nothing
 * else. One scanner process for all of them; the output is parsed into
 * path -> detector ids.
 *
 * The run is EXPECTED to exit non-zero, because positive controls must fire. The
 * exit code is asserted separately at the end, against a file with no findings.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCANNER = join(REPO, 'scripts/quality/secret-scan.mjs');

// The scanner under test prints colour codes, so its output has to be stripped
// before it can be asserted on. Matching the escape character is the entire
// purpose of this pattern — without `\x1b` in it there is nothing to strip — so
// the rule is wrong here rather than the code. Silenced for this line only.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \u2705 [PASS] ${label}`);
  } else {
    failed++;
    console.log(`  \u274c [FAIL] ${label}`);
    if (detail) console.log(`         ${detail}`);
  }
}

/** Assemble a fixture from fragments no detector can match on its own. */
const j = (...parts) => parts.join('');

/**
 * Every case. `mustFire` is the whole point of the table.
 *
 * `ids` lists the detector ids expected; for `mustFire: false` it is empty and
 * the assertion is that the file appears in the output at all.
 */
const CASES = [
  // -------------------------------------------------------------------------
  // POSITIVE CONTROLS — these MUST be caught. Each one is a near miss for an
  // exemption added in this change.
  // -------------------------------------------------------------------------
  {
    name: 'remote-db-url',
    mustFire: true,
    ids: ['postgres-url-with-password'],
    why: 'the loopback exemption must not extend to a remote host',
    body: `const DATABASE_URL = '${j('postgresql://oneteam:', 'S3cr3tPr0dP4ss', '@db.customer.example.com:5432/oneteam')}';`,
  },
  {
    name: 'compose-service-host',
    mustFire: true,
    ids: ['postgres-url-with-password'],
    why: 'a compose service name is not loopback, and its password is often reused',
    body: `const DATABASE_URL = '${j('postgresql://oneteam:', 'S3cr3tPr0dP4ss', '@postgres:5432/oneteam')}';`,
  },
  {
    name: 'short-service-host',
    mustFire: true,
    ids: ['postgres-url-with-password'],
    why: 'the two-letter compose name must not slip through the same exemption',
    body: `const DATABASE_URL = '${j('postgresql://oneteam:', 'S3cr3tPr0dP4ss', '@db:5432/oneteam')}';`,
  },
  {
    name: 'loopback-lookalike-host',
    mustFire: true,
    ids: ['postgres-url-with-password'],
    why: 'a hostname that merely STARTS with localhost is a different host',
    body: `const DATABASE_URL = '${j('postgresql://oneteam:', 'S3cr3tPr0dP4ss', '@localhost.attacker.example:5432/oneteam')}';`,
  },
  {
    name: 'telegram-bot-token',
    mustFire: true,
    ids: ['telegram-bot-token'],
    why: 'this project runs a Telegram bot, so this detector matters most',
    body: `const BOT_TOKEN = '${j('7123456789', ':', 'AAHfQwErTyUiOpAsDfGhJkLzXcVbNmQwErTy')}';`,
  },
  {
    name: 'openai-key',
    mustFire: true,
    ids: ['openai-key'],
    why: 'the catch-all must not have been widened into silence',
    body: `const API_KEY = '${j('sk-proj-', '9fJ2kLmNpQrStUvWxYz', '0123456789abcdefghijkl')}';`,
  },
  {
    name: 'github-token',
    mustFire: true,
    ids: ['github-token'],
    why: 'a repository-scoped token in source is a full compromise',
    body: `const GH = '${j('ghp_', '9fJ2kLmNpQrStUvWxYz', '0123456789abcd')}';`,
  },
  {
    name: 'private-key-block',
    mustFire: true,
    ids: ['private-key'],
    why: 'the defect class that put a real SSH key into this repository',
    body: j(
      '-----BEGIN OPENSSH ',
      'PRIVATE KEY-----',
      '\n',
      'b3BlbnNzaC1rZXktdjEAAAAA',
      '\n',
      '-----END OPENSSH ',
      'PRIVATE KEY-----',
    ),
  },
  {
    name: 'device-token-without-giveaway',
    mustFire: true,
    ids: ['generic-assigned-secret'],
    why: 'the self-describing-fake test must not exempt a token that does not confess',
    body: `const token = '${j('otd_', '9fJ2kLmNpQrStUvWxYz', '0123456789abcdefghijkl')}';`,
  },
  {
    name: 'base64-secret-not-in-an-image',
    mustFire: true,
    ids: ['high-entropy-string'],
    why: 'the image exemption must be scoped to an actual image concatenation',
    body: `const SIGNING_KEY = '${j('wJalrXUtnFEMI/K7MDENG', '/bPxRfiCYq8Z2mN4pL6vT9sH3kD1gB5cA')}';`,
  },
  {
    name: 'image-signature-in-a-neighbouring-statement',
    mustFire: true,
    ids: ['high-entropy-string'],
    why: 'the image exemption must not leak into a statement that merely follows one',
    body: [
      `const photo = '${j('/9j/4AAQSkZJRgABAQEAYABgAAD', 'x')}';`,
      `const SIGNING_KEY = '${j('wJalrXUtnFEMI/K7MDENG', '/bPxRfiCYq8Z2mN4pL6vT9sH3kD1gB5cA')}';`,
    ].join('\n'),
  },

  // -------------------------------------------------------------------------
  // NEGATIVE CONTROLS — the 13 real findings. None may fire.
  // -------------------------------------------------------------------------
  {
    name: 'pg-localhost-fallback',
    mustFire: false,
    why: 'the standard local development fallback in five test files',
    body: `process.env.DATABASE_URL || '${j('postgresql://postgres:', 'postgres', '@localhost:5432/postgres')}';`,
  },
  {
    name: 'pg-127-0-0-1',
    mustFire: false,
    why: 'loopback by address rather than by name',
    body: `const u = '${j('postgresql://oneteam:', 'oneteam', '@127.0.0.1:5432/oneteam')}';`,
  },
  {
    name: 'pg-ipv6-loopback',
    mustFire: false,
    why: 'bracketed IPv6 loopback cannot be split on a colon',
    body: `const u = '${j('postgresql://oneteam:', 'oneteam', '@[::1]:5432/oneteam')}';`,
  },
  {
    name: 'env-example-comment',
    mustFire: false,
    why: 'a commented-out example line in .env.example',
    body: `# DATABASE_URL=${j('postgresql://oneteam:', 'password', '@localhost:5432/oneteam?sslmode=disable')}`,
  },
  {
    name: 'self-describing-panel-key',
    mustFire: false,
    why: 'the value says it is not a real key',
    body: `    token: '${j('otp_', 'definitelynot', 'arealkeyatall')}',`,
  },
  {
    name: 'self-describing-device-token',
    mustFire: false,
    why: 'the value says it is not a real device token',
    body: `    token: '${j('otd_', 'not', 'arealdevicetoken')}',`,
  },
  {
    name: 'interpolated-service-credential',
    mustFire: false,
    why: 'a template literal is built at runtime, so it cannot be a literal secret',
    body: '    { token: `oneteam-user:${token}` },',
  },
  {
    name: 'url-path-route',
    mustFire: false,
    why: 'a route is 43 varied characters and cleared the entropy threshold',
    body: `  const ackForeign = await call('POST', '/api/portal/field/tasks/any-task/acknowledge', {`,
  },
  {
    name: 'png-fixture',
    mustFire: false,
    why: 'a 1x1 PNG encoded as base64',
    body: `    '${j(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      'CAYAAAAfFcSJAAAADUlEQVR42mNk',
      '+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    )}';`,
  },
  {
    name: 'jpeg-concatenation',
    mustFire: false,
    why: 'only the FIRST chunk carries the signature; the rest must not fire either',
    body: [
      `  '${j('/9j/4AAQSkZJRgABAQEAYABgAAD', '/2wBDAAgGBgcGBQgHBwcJCQgK', 'DBQNDAsLDBkSEw8UHRofHh0a')}' +`,
      `  '${j('HBwgJC4nICIsIxwcKDcpLDAxNDQ0', 'Hyc5PTgyPC4zNDL/wAALCAABAAEB', 'AREA/8QAFAABAAAAAAAA')}' +`,
      `  '${j('Hh0aHBwgJC4nICIsIxwcKDcpLDAx', 'NDQ0Hyc5PTgyPC4zNDI=')}';`,
    ].join('\n'),
  },
  {
    name: 'csp-sha256-hash-source',
    mustFire: false,
    why: 'a CSP/SRI hash is a public integrity digest served in a header, not a secret',
    body: `add_header Content-Security-Policy "script-src 'self' '${j(
      'sha256-',
      'NxvTC/dARrj02zNc8V9u5Rui1',
      'mcE5DEySgyUiCTVNSk=',
    )}'";`,
  },
];

// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'oneteam-secret-cases-'));

try {
  console.log('Secret scanner — positive and negative controls\n');

  const paths = [];
  for (const testCase of CASES) {
    const path = join(dir, `${testCase.name}.ts`);
    writeFileSync(path, `${testCase.body}\n`, 'utf8');
    paths.push(path);
  }

  let output = '';
  try {
    output = execFileSync('node', [SCANNER, '--files', ...paths], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // A non-zero exit is expected here: the positive controls must fire.
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }

  const clean = output.replace(ANSI, '');

  // Parse "✗ [SEVERITY] id" + "file : path:line" pairs into path -> ids.
  const found = new Map();
  const lines = clean.split('\n');
  let currentId = null;
  for (const line of lines) {
    const hit = line.match(/✗\s+\[(?:CRITICAL|HIGH|MEDIUM)\]\s+(\S+)/);
    if (hit) {
      currentId = hit[1];
      continue;
    }
    const file = line.match(/file\s*:\s*(.+?):(\d+)\s*$/);
    if (file && currentId) {
      const path = file[1];
      if (!found.has(path)) found.set(path, []);
      found.get(path).push(currentId);
      currentId = null;
    }
  }

  check(
    'the scanner produced a report at all',
    clean.includes('file(s) checked'),
    `output did not look like a scanner report:\n${clean.slice(0, 400)}`,
  );

  let firedCount = 0;
  let quietCount = 0;

  for (const testCase of CASES) {
    const path = join(dir, `${testCase.name}.ts`);
    const ids = found.get(path) ?? [];
    const fired = ids.length > 0;

    if (testCase.mustFire) {
      firedCount++;
      const idsOk = testCase.ids.every((id) => ids.includes(id));
      check(
        `fires: ${testCase.name} — ${testCase.why}`,
        fired && idsOk,
        fired
          ? `fired as [${ids.join(', ')}], expected [${testCase.ids.join(', ')}]`
          : 'did NOT fire — the exemption is wider than it should be',
      );
    } else {
      quietCount++;
      check(
        `stays quiet: ${testCase.name} — ${testCase.why}`,
        !fired,
        `fired as [${ids.join(', ')}] — this is the false positive that kept CI red`,
      );
    }
  }

  check(
    'the scanner still reports a non-zero exit when there are findings',
    (() => {
      try {
        execFileSync('node', [SCANNER, '--files', ...paths], { cwd: REPO, stdio: 'ignore' });
        return false;
      } catch {
        return true;
      }
    })(),
    'a scanner that only warns is decoration',
  );

  check(
    'and exits zero on a file with no findings',
    (() => {
      const innocent = join(dir, 'innocent.ts');
      writeFileSync(innocent, 'export const greeting = "hello";\n', 'utf8');
      try {
        const out = execFileSync('node', [SCANNER, '--files', innocent], {
          cwd: REPO,
          encoding: 'utf8',
        });
        return out.includes('No credentials detected');
      } catch {
        return false;
      }
    })(),
    'the scanner must be able to pass, or "green" means nothing',
  );

  // -------------------------------------------------------------------------
  // `--all` must see a file that exists but has not been staged.
  //
  // This is the trap that produced the whole commit: the scanner reads
  // `git ls-files`, so an untracked file is invisible to it. The local check
  // reported "clean over 180 files" while a file containing 11 CRITICAL findings
  // sat on disk, unstaged, and CI found it immediately afterwards.
  //
  // A real git repository is built here so the behaviour is measured, not
  // assumed — and it is measured from the OUTSIDE, the way CI sees it.
  // -------------------------------------------------------------------------
  {
    const sandbox = join(dir, 'untracked-repo');
    mkdirSync(sandbox, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: sandbox });
    writeFileSync(
      join(sandbox, 'unstaged-secret.ts'),
      `const API_KEY = '${j('sk-proj-', '9fJ2kLmNpQrStUvWxYz', '0123456789abcdefghijkl')}';\n`,
      'utf8',
    );

    let out = '';
    try {
      out = execFileSync('node', [SCANNER, '--all'], { cwd: sandbox, encoding: 'utf8' });
    } catch (error) {
      out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }

    const cleanOut = out.replace(ANSI, '');
    check(
      '--all finds a secret in a file that is on disk but NOT yet staged',
      cleanOut.includes('unstaged-secret.ts') && cleanOut.includes('openai-key'),
      `the untracked file was invisible to --all:\n${cleanOut.slice(0, 400)}`,
    );
    check(
      'and says so in the mode line, so the coverage is visible',
      /untracked/i.test(cleanOut),
      `mode line did not mention untracked files:\n${cleanOut.split('\n')[1] ?? ''}`,
    );
  }

  console.log(
    `\n  ${firedCount} positive control(s) fired, ${quietCount} negative control(s) stayed quiet.`,
  );
  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
