#!/usr/bin/env node
/**
 * Route authentication coverage guard — the break detector for a new endpoint
 * that quietly ships without a guard.
 * ============================================================================
 *
 * THE DEFECT THIS GUARDS
 * ----------------------
 * `AuthGuard` is attached per-controller (or per-method) with `@UseGuards`. It
 * is NOT a global guard, so a route is protected only if a decorator says so.
 * That means the default for a brand-new endpoint is "reachable by anyone", and
 * the way that hole gets opened is not malice — it is adding a `@Get()` next to
 * a guarded one and not noticing the class decorator does not reach it, or
 * introducing a new controller and forgetting the class-level `@UseGuards`.
 *
 * `panel-auth.spec.ts` proves, at runtime, that the guard is load-bearing on the
 * routes it lists. It cannot enumerate the routes nobody wrote it for. This can:
 * it walks every controller and fails on any route that is neither guarded nor
 * an explicit, named exemption.
 *
 * WHY A SOURCE-LEVEL GUARD, NOT A RUNNING SERVER
 * ----------------------------------------------
 * A behavioural test only covers the routes someone remembered to add to it.
 * The class of defect here is precisely the route nobody remembered. Parsing the
 * decorators is the only way to see the whole surface at once, and it runs in
 * the gate with no database, so it fires on the commit that opens the hole.
 *
 * WHAT AN EXEMPTION MEANS
 * -----------------------
 * A route is public on purpose, and the reason is written down. An exemption
 * with no reason is a hole with a label, so the guard also requires the reason
 * to be present. If you are adding a route and this test fails, either add
 * `@UseGuards(AuthGuard)` or add an exemption with a real justification — do not
 * broaden an existing one.
 *
 *   npm run test:auth-coverage
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULES = join(ROOT, 'apps', 'api', 'src', 'modules');

/**
 * Routes that are reachable without a bearer, each with the reason it must be.
 *
 * Key format: `METHOD <controller path>/<route path>` (no leading slash).
 * Kept deliberately small — every entry is a hole, and a hole is only
 * acceptable when the reason below it is true.
 */
const PUBLIC_ROUTES = new Map([
  [
    'GET api/health',
    'Liveness for Railway and monitors; it must answer without a credential or the platform cannot tell a dead API from a locked one (health.controller.ts).',
  ],
  [
    'POST api/webhooks/telegram',
    'Telegram cannot present a user session. Guarded by x-telegram-bot-api-secret-token, validated with timingSafeEqual in assertTrustedSender before any body is trusted (webhook.controller.ts).',
  ],
  [
    'GET api/portal/field/store-lookup',
    'Pre-auth enrollment: the field app looks up a store by code BEFORE anyone has a credential, so this must answer bare. It returns only store name/city (enrollment.controller.ts).',
  ],
  [
    'POST api/portal/field/enroll',
    'Pre-auth enrollment handshake that mints the device credential and stores its half; it IS the credential bootstrap, so it must be reachable from bare metal. Guarded by device-proof in the body (enrollment.controller.ts).',
  ],
  [
    'GET api/panel/auth-status',
    'Public by design: the login screen calls it before it has a key, to learn whether a key is even required. It reports counts and configuration, not key material (panelAuth.ts documents the contract).',
  ],
]);

/** Security-critical routes whose silent disappearance must fail the guard. */
const MUST_EXIST = [
  'GET api/panel/me',
  'GET api/panel/keys',
  'POST api/panel/keys',
  'POST api/panel/keys/:prefix/revoke',
  'DELETE api/panel/users/:userId',
  'POST api/portal/submissions/:id/review',
  'POST api/portal/submissions/:id/auto-approve',
  'POST api/portal/tasks',
  'PATCH api/portal/tasks/:id',
  'DELETE api/portal/tasks/:id',
];

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✅ [PASS] ${label}`);
  } else {
    failed++;
    console.log(`  ❌ [FAIL] ${label}`);
    if (detail) console.log(`         ${detail}`);
  }
}

/** Every `*.controller.ts` under `apps/api/src/modules`, recursively. */
function controllers(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...controllers(full));
    else if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

/** Comments are stripped so a route mentioned in prose is not read as a route. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const ROUTE_RE = /@(Get|Post|Patch|Put|Delete|All|Head|Options)\(([^)]*)\)/;
const CTRL_RE = /@Controller\(([^)]*)\)/;

/** `'api/health/'` → `api/health`; `''` stays `''`. */
function normalize(path) {
  return path
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

const routes = [];
for (const file of controllers(MODULES)) {
  const src = stripComments(readFileSync(file, 'utf8'));
  const ctrlMatch = CTRL_RE.exec(src);
  const ctrl = ctrlMatch ? normalize(ctrlMatch[1]) : '';
  const lines = src.split('\n');
  const firstRoute = lines.findIndex((line) => ROUTE_RE.test(line));
  const classGuarded =
    firstRoute > 0 &&
    lines.slice(0, firstRoute).some((line) => line.trim().startsWith('@UseGuards('));

  const indices = lines.map((line, i) => [i, line]).filter(([, line]) => ROUTE_RE.test(line));
  indices.forEach(([i], k) => {
    const end = k + 1 < indices.length ? indices[k + 1][0] : lines.length;
    const segment = lines.slice(i, end);
    const m = ROUTE_RE.exec(lines[i]);
    const guarded = classGuarded || segment.some((line) => line.trim().startsWith('@UseGuards('));
    const routePath = normalize(m[2]);
    const key = routePath
      ? `${m[1].toUpperCase()} ${ctrl}/${routePath}`
      : `${m[1].toUpperCase()} ${ctrl}`;
    routes.push({ key, guarded, file: file.replace(`${ROOT}/`, '') });
  });
}

console.log('route authentication coverage guard\n');

// --- 0. The walker actually found the surface ---------------------------------
check(
  'the controller walk found the API surface (a guard that parses nothing passes nothing)',
  routes.length >= 60,
  `found ${routes.length} routes; if this is near zero the parser broke, not the API`,
);

// --- 1. Every unguarded route is a named, justified exemption -----------------
const unguarded = routes.filter((r) => !r.guarded);
const unexplained = unguarded.filter((r) => !PUBLIC_ROUTES.has(r.key));
check(
  'every route without a guard is a deliberate, documented exemption',
  unexplained.length === 0,
  unexplained.length > 0
    ? 'guard-less routes with no reason: ' +
        unexplained.map((r) => `\n           ${r.key}  (${r.file})`).join('')
    : '',
);

// --- 2. Exemptions carry a real reason ---------------------------------------
const blankReasons = [...PUBLIC_ROUTES.entries()].filter(
  ([, reason]) => !reason || reason.trim().length < 12,
);
check(
  'every exemption states why the route is public',
  blankReasons.length === 0,
  blankReasons.map(([key]) => `\n           ${key} — no reason given`).join(''),
);

// --- 3. No exemption outlives its route (a renamed route must not inherit one)-
const keys = new Set(routes.map((r) => r.key));
const stale = [...PUBLIC_ROUTES.keys()].filter((key) => !keys.has(key));
check(
  'no exemption points at a route that no longer exists',
  stale.length === 0,
  stale
    .map((key) => `\n           ${key} — exempted but not found; the route was renamed or removed`)
    .join(''),
);

// --- 4. Security-critical routes are still present ---------------------------
const missing = MUST_EXIST.filter((key) => !keys.has(key));
check(
  'the security-critical routes still exist',
  missing.length === 0,
  missing
    .map((key) => `\n           ${key} — gone; was it renamed, or removed on purpose?`)
    .join(''),
);

// --- 5. A guarded route is not also exempted (the two lists cannot disagree) ---
const contradictory = [...PUBLIC_ROUTES.keys()].filter(
  (key) => keys.has(key) && routes.find((r) => r.key === key)?.guarded,
);
check(
  'no route is both guarded and exempted',
  contradictory.length === 0,
  contradictory.map((key) => `\n           ${key} — has @UseGuards AND an exemption`).join(''),
);

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
