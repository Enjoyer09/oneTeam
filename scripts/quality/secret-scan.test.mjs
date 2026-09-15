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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCANNER = join(REPO, 'scripts/quality/secret-scan.mjs');

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
    body: `const DATABASE_URL = 'postgresql://oneteam:S3cr3tPr0dP4ss@db.customer.example.com:5432/oneteam';`,
  },
  {
    name: 'compose-service-host',
    mustFire: true,
    ids: ['postgres-url-with-password'],
    why: 'a compose service name is not loopback, and its password is often reused',
    body: `const DATABASE_URL = 'postgresql://oneteam:S3cr3tPr0dP4ss@postgres:5432/oneteam';`,
  },
  {
    name: 'short-service-host',
    mustFire: true,
    ids: ['postgres-url-with-password'],
    why: 'the two-letter compose name must not slip through the same exemption',
    body: `const DATABASE_URL = 'postgresql://oneteam:S3cr3tPr0dP4ss@db:5432/oneteam';`,
  },
  {
    name: 'loopback-lookalike-host',
    mustFire: true,
    ids: ['postgres-url-with-password'],
    why: 'a hostname that merely STARTS with localhost is a different host',
    body: `const DATABASE_URL = 'postgresql://oneteam:S3cr3tPr0dP4ss@localhost.attacker.example:5432/oneteam';`,
  },
  {
    name: 'telegram-bot-token',
    mustFire: true,
    ids: ['telegram-bot-token'],
    why: 'this project runs a Telegram bot, so this detector matters most',
    body: `const BOT_TOKEN = '7123456789:AAHfQwErTyUiOpAsDfGhJkLzXcVbNmQwErTy';`,
  },
  {
    name: 'openai-key',
    mustFire: true,
    ids: ['openai-key'],
    why: 'the catch-all must not have been widened into silence',
    body: `const API_KEY = 'sk-proj-9fJ2kLmNpQrStUvWxYz0123456789abcdefghijkl';`,
  },
  {
    name: 'github-token',
    mustFire: true,
    ids: ['github-token'],
    why: 'a repository-scoped token in source is a full compromise',
    body: `const GH = 'ghp_9fJ2kLmNpQrStUvWxYz0123456789abcd';`,
  },
  {
    name: 'private-key-block',
    mustFire: true,
    ids: ['private-key'],
    why: 'the defect class that put a real SSH key into this repository',
    body: `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----`,
  },
  {
    name: 'device-token-without-giveaway',
    mustFire: true,
    ids: ['generic-assigned-secret'],
    why: 'the self-describing-fake test must not exempt a token that does not confess',
    body: `const token = 'otd_9fJ2kLmNpQrStUvWxYz0123456789abcdefghijkl';`,
  },
  {
    name: 'base64-secret-not-in-an-image',
    mustFire: true,
    ids: ['high-entropy-string'],
    why: 'the image exemption must be scoped to an actual image concatenation',
    body: `const SIGNING_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYq8Z2mN4pL6vT9sH3kD1gB5cA';`,
  },
  {
    name: 'image-signature-in-a-neighbouring-statement',
    mustFire: true,
    ids: ['high-entropy-string'],
    why: 'the image exemption must not leak into a statement that merely follows one',
    body: [
      `const photo = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a';`,
      `const SIGNING_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYq8Z2mN4pL6vT9sH3kD1gB5cA';`,
    ].join('\n'),
  },

  // -------------------------------------------------------------------------
  // NEGATIVE CONTROLS — the 13 real findings. None may fire.
  // -------------------------------------------------------------------------
  {
    name: 'pg-localhost-fallback',
    mustFire: false,
    why: 'the standard local development fallback in five test files',
    body: `process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';`,
  },
  {
    name: 'pg-127-0-0-1',
    mustFire: false,
    why: 'loopback by address rather than by name',
    body: `const u = 'postgresql://oneteam:oneteam@127.0.0.1:5432/oneteam';`,
  },
  {
    name: 'pg-ipv6-loopback',
    mustFire: false,
    why: 'bracketed IPv6 loopback cannot be split on a colon',
    body: `const u = 'postgresql://oneteam:oneteam@[::1]:5432/oneteam';`,
  },
  {
    name: 'env-example-comment',
    mustFire: false,
    why: 'a commented-out example line in .env.example',
    body: `# DATABASE_URL=postgresql://oneteam:password@localhost:5432/oneteam?sslmode=disable`,
  },
  {
    name: 'self-describing-panel-key',
    mustFire: false,
    why: 'the value says it is not a real key',
    body: `    token: 'otp_definitelynotarealkeyatall',`,
  },
  {
    name: 'self-describing-device-token',
    mustFire: false,
    why: 'the value says it is not a real device token',
    body: `    token: 'otd_notarealdevicetoken',`,
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
    body: `    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';`,
  },
  {
    name: 'jpeg-concatenation',
    mustFire: false,
    why: 'only the FIRST chunk carries the signature; the rest must not fire either',
    body: [
      `  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +`,
      `  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +`,
      `  'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDI=';`,
    ].join('\n'),
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

  console.log(
    `\n  ${firedCount} positive control(s) fired, ${quietCount} negative control(s) stayed quiet.`,
  );
  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
