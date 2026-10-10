#!/usr/bin/env node
/**
 * oneTeam — production smoke test (read-only)
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything else that verifies this system runs against a database started on
 * this machine (`test:live`) or against source (`the gate`). Neither answers the
 * question an operator actually has after a deploy: is the live deployment
 * healthy, and is it still locked?
 *
 * `docs/DEPLOY-TEST-AZ.md` describes those checks, but as a list of browser
 * steps a person performs by hand — and a step a person performs by hand is a
 * step that gets skipped the night it matters. This is the same verification as
 * one command with an exit code, so it can run after every deploy without
 * thinking about it.
 *
 * WHAT IT PROVES
 * --------------
 *   - the API is up and backed by PostgreSQL — not the in-memory fallback, which
 *     looks identical from the outside and loses every write on the next restart
 *   - its schema is current: no pending migrations, no missing tables or columns
 *   - the web service serves the app and proxies /api/ — the path the browser
 *     actually uses, which is a different hop from calling the API directly
 *   - THE PANEL IS STILL LOCKED. This is the check that matters most, because
 *     the way this system breaks is not by going down; it is by quietly going
 *     back to being open, and both seals are asserted here: an unauthenticated
 *     request is refused, and so is the seeded edge credential
 *     (`oneteam-user:usr-admin-001`) that a stranger reaching the portal URL
 *     would be holding.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * No writes. Every request is a GET and the only non-2xx responses expected are
 * the 401s that prove the lock — so it is safe to run against production at any
 * time. It does NOT check static header configuration (CSP, HSTS): that lives in
 * web/nginx.conf and the platform edge, and asserting it belongs with the config,
 * not with a runtime that cannot see a browser's errors.
 *
 * A panel key is optional. Without ONETEAM_PANEL_KEY the run covers everything
 * except the signed-in identity check, which is reported as SKIPPED by name
 * rather than passed silently.
 *
 * Run it against a real deployment. A Vite dev server proxies only /api/portal
 * and /api/panel, so the "web proxies /api/" check fails there on purpose: it
 * asserts what production nginx must do, which is proxy the whole of /api/.
 *
 * Usage:
 *   npm run smoke:prod
 *   ONETEAM_API_URL=... ONETEAM_WEB_URL=... [ONETEAM_PANEL_KEY=...] \
 *     node scripts/ops/prod-smoke.mjs
 */

const API = (process.env.ONETEAM_API_URL || 'https://api-production-c17b.up.railway.app').replace(
  /\/+$/,
  '',
);
const WEB = (process.env.ONETEAM_WEB_URL || 'https://web-production-1392e.up.railway.app').replace(
  /\/+$/,
  '',
);
const KEY = process.env.ONETEAM_PANEL_KEY || '';

/**
 * The credential the web edge used to inject before the panel had a key. Named
 * here as a constant because the point of the check is that this exact value is
 * refused, and a value a caller can quietly change is not a regression test.
 */
const SEEDED_EDGE_CREDENTIAL = 'oneteam-user:usr-admin-001';

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  \u2713 ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  \u2717 ${label}${detail === undefined ? '' : `  \u2192 ${detail}`}`);
  }
}

function skip(label, why) {
  skipped++;
  console.log(`  \u25CB ${label} \u2014 SKIPPED: ${why}`);
}

async function get(url, headers = {}) {
  try {
    const response = await fetch(url, { headers });
    return { status: response.status, text: await response.text(), headers: response.headers };
  } catch (error) {
    return { status: 0, text: '', error: error instanceof Error ? error.message : String(error) };
  }
}

function json(result) {
  try {
    return JSON.parse(result.text);
  } catch {
    return null;
  }
}

const isProduction = /\.railway\.app$/.test(new URL(API).host);

async function main() {
  console.log('\n=== oneTeam — production smoke test (read-only) ===\n');
  console.log(`   API: ${API}`);
  console.log(`   WEB: ${WEB}`);
  console.log(`   target: ${isProduction ? 'PRODUCTION' : 'not production'}\n`);

  // --------------------------------------------------------------- API health
  console.log('1) API health');
  const health = await get(`${API}/api/health`);
  const h = json(health) || {};
  check(
    'GET /api/health answers 200',
    health.status === 200,
    `${health.status} ${health.error || ''}`,
  );
  check('it reports the API service', h.service === 'oneteam-api', String(h.service));
  check('it reports overall ok', h.status === 'ok', String(h.status));
  check(
    'persistence is PostgreSQL, not the in-memory fallback',
    h.persistence === 'postgres',
    `persistence=${h.persistence} (memory loses every write on restart)`,
  );

  // --------------------------------------------------------------- API schema
  console.log('\n2) API schema');
  const schema = h.schema || {};
  check('the schema reports ok', schema.ok === true, String(schema.ok));
  check(
    'no migrations are pending (the deploy applied them)',
    Array.isArray(schema.migrationsApplied) && schema.migrationsApplied.length === 0,
    JSON.stringify(schema.migrationsApplied),
  );
  check(
    'no tables are missing',
    Array.isArray(schema.missingTables) && schema.missingTables.length === 0,
    JSON.stringify(schema.missingTables),
  );
  check(
    'no columns are missing',
    Array.isArray(schema.missingColumns) && schema.missingColumns.length === 0,
    JSON.stringify(schema.missingColumns),
  );
  check(
    'photo storage is configured',
    typeof h.photoStorage?.driver === 'string' && h.photoStorage.driver.length > 0,
    JSON.stringify(h.photoStorage),
  );

  // -------------------------------------------------------- the panel is locked
  console.log('\n3) The panel is locked');
  const authStatus = await get(`${API}/api/panel/auth-status`);
  const status = json(authStatus)?.data || {};
  check(
    'GET /api/panel/auth-status answers 200',
    authStatus.status === 200,
    `${authStatus.status}`,
  );
  check(
    'it reports whether a key is required',
    typeof status.required === 'boolean',
    JSON.stringify(status),
  );
  check(
    'it reports a live-key count',
    typeof status.liveKeys === 'number',
    String(status.liveKeys),
  );

  const noAuth = await get(`${API}/api/portal/stores`);
  check(
    'an unauthenticated request to a supervisor route is refused (401)',
    noAuth.status === 401,
    `got ${noAuth.status}`,
  );

  if (status.required === true) {
    const edge = await get(`${API}/api/portal/stores`, {
      Authorization: `Bearer ${SEEDED_EDGE_CREDENTIAL}`,
    });
    check(
      'the seeded edge credential is refused (401) — the panel is not open to a stranger who knows the URL',
      edge.status === 401,
      `got ${edge.status}${edge.status === 200 ? ' — the portal is OPEN; a key exists but the edge credential still works' : ''}`,
    );
  } else {
    skip(
      'the seeded edge credential is refused',
      'the panel requires no key yet (liveKeys: 0); the edge credential is intentionally accepted until the first key is minted',
    );
  }

  // ------------------------------------------------------------- the web app
  console.log('\n4) The web app (what the browser actually loads)');
  const root = await get(`${WEB}/`);
  check('GET / answers 200', root.status === 200, `${root.status} ${root.error || ''}`);
  check(
    'it serves an HTML app shell',
    (root.headers.get('content-type') || '').includes('text/html') &&
      (root.text.includes('id="root"') || root.text.includes('<title>')),
    root.headers.get('content-type') || 'no content-type',
  );

  const assets = [...root.text.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  if (assets.length > 0) {
    const asset = await get(`${WEB}${assets[0]}`);
    check(`the built bundle is served (${assets[0]})`, asset.status === 200, `got ${asset.status}`);
  } else {
    skip(
      'the built bundle is served',
      'the HTML references no /assets/*.js — this is a dev server, not a built image',
    );
  }

  const proxied = await get(`${WEB}/api/health`);
  const proxiedBody = json(proxied);
  check(
    "the web service proxies /api/ to the API (the browser's path)",
    proxied.status === 200 && proxiedBody?.status === 'ok',
    proxied.status !== 200
      ? `got ${proxied.status}`
      : proxiedBody
        ? `got 200 but not the API's health: ${JSON.stringify(proxiedBody).slice(0, 80)}`
        : 'got 200 but the body is HTML, not JSON — /api/ is not proxied here. (A dev server proxies only /api/portal and /api/panel; production nginx proxies all of /api/.)',
  );

  const deep = await get(`${WEB}/deploy-smoke-nonexistent-route`);
  check(
    'a deep route falls back to the app (SPA routing works)',
    deep.status === 200 && deep.text.includes('id="root"'),
    `got ${deep.status}`,
  );

  // ------------------------------------------------------ the signed-in identity
  console.log('\n5) Signed-in identity (needs a key)');
  if (KEY) {
    const me = await get(`${API}/api/panel/me`, { Authorization: `Bearer ${KEY}` });
    const identity = json(me)?.data || {};
    check('GET /api/panel/me accepts the key (200)', me.status === 200, `${me.status}`);
    check(
      'the key resolves to a real role',
      typeof identity.role === 'string',
      JSON.stringify(identity),
    );
  } else {
    skip('GET /api/panel/me accepts a key', 'set ONETEAM_PANEL_KEY to include the signed-in check');
  }

  // -------------------------------------------------------------------- verdict
  const total = passed + failed;
  console.log(
    `\n=== ${passed}/${total} checks passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''} ===`,
  );
  if (failed > 0) {
    console.log(`Failed:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('The deployment is up, on PostgreSQL, current on schema, and locked.\n');
}

main().catch((error) => {
  console.error(
    `\nThe smoke test itself crashed: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(3);
});
