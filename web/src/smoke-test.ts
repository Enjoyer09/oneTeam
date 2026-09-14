/**
 * oneTeam Supervisor & Admin Portal — Data-path smoke test
 * ============================================================================
 *
 * WHAT THIS USED TO BE, AND WHY IT CHANGED
 * ----------------------------------------
 * This file used to assert against the panel's own mock data: it looked for a
 * store called `BRAVO_28MAY_01`, a submission called `sub-001`, and a review
 * message containing "AI Avtomatik Təsdiqi". None of those ever existed in the
 * real catalogue. It printed "ALL WEB SERVICE SMOKE TESTS PASSED (100%
 * OPERATIONAL)" because it was checking an in-memory array against itself, and
 * it kept printing that while the panel was showing invented stores.
 *
 * It now reads the real API. If the API is not reachable, it says so and fails —
 * a test that cannot check anything must not report success.
 *
 * WHY IT IS READ-ONLY BY DEFAULT
 * ------------------------------
 * The write paths (creating a briefing, reviewing an audit, auto-approval) all
 * mutate whatever database the API is pointed at. Running them by default means
 * that anyone who runs `npm run web:test` against production silently adds demo
 * tasks to the real catalogue.
 *
 * They are exercised when `ONETEAM_SMOKE_WRITES=1` is set — point that at a
 * development database. The API's own integration suites (`npm run test:core`,
 * `npm run test:phase2`) already cover the write paths against an in-process
 * API, which is why leaving them out here costs no real coverage.
 */

import { portalService } from './lib/portalApi';

/** Real store code from `db/api-seed.sql`. */
const EXPECTED_STORE_CODE = 'BRAVO_YASAMAL_01';

const RUN_WRITES = process.env.ONETEAM_SMOKE_WRITES === '1';

function heading(text: string) {
  console.log(`\n${text}`);
}

function ok(text: string) {
  console.log(`   ✓ ${text}`);
}

async function runWebSmokeTest() {
  console.log('============================================================');
  console.log('  oneTeam WEB PORTAL — DATA-PATH SMOKE TEST');
  console.log('============================================================');
  console.log(`\n  Mode: ${RUN_WRITES ? 'READ + WRITE (ONETEAM_SMOKE_WRITES=1)' : 'READ-ONLY'}`);

  // The panel calls a same-origin path in production because nginx proxies it.
  // Running this file standalone has no proxy, so it needs both a base URL and a
  // credential — and saying that up front beats a confusing network error.
  if (!process.env.VITE_API_BASE_URL || !process.env.ONETEAM_API_TOKEN) {
    throw new Error(
      'This test talks to the API directly, so it needs both variables:\n\n' +
        '     VITE_API_BASE_URL=http://localhost:3001 \\\n' +
        '     ONETEAM_API_TOKEN=oneteam-user:usr-admin-001 \\\n' +
        '     npm run web:test\n\n' +
        '   (In the deployed panel neither is needed: nginx proxies /api/, and a\n' +
        '    signed-in supervisor supplies their own key.)',
    );
  }

  // -------------------------------------------------------------------------
  // 0. Is the supervisor API even open to this credential?
  // -------------------------------------------------------------------------
  //
  // Once a panel key exists, the supervisor routes stop accepting a service
  // credential — that is the whole point of the login, and it is asserted in
  // `npm run test:panel`. This suite stands in for a supervisor using one, so
  // against a configured panel it would fail with a 403 on the first call and
  // read like a broken API rather than a closed door.
  //
  // Asked up front, and answered in words, because the two situations need
  // completely different responses from whoever is running this.
  const authStatus = await fetch(`${process.env.VITE_API_BASE_URL}/api/panel/auth-status`)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);

  // A panel key IS the credential this suite should be using against a
  // configured panel, so passing one is the answer rather than a problem. The
  // first version of this check refused both, which made the escape hatch it
  // recommended in its own error message not work.
  const usingPanelKey = (process.env.ONETEAM_API_TOKEN || '').startsWith('otp_');

  if (authStatus?.data?.required === true && !usingPanelKey) {
    console.log(
      '\n  ⚠️  The supervisor panel is configured: it now requires a panel key, and\n' +
        '      a service credential is refused on the routes this suite exercises.\n\n' +
        '      Either run against a database with no live panel keys (see\n' +
        '      `npm run test:panel`, which cleans up after itself), or pass a key:\n\n' +
        '        ONETEAM_API_TOKEN=otp_... npm run web:test\n',
    );
    throw new Error('The panel requires a key — see the note above.');
  }

  if (authStatus?.data?.required === true) {
    console.log('  Using a panel key against a configured panel.');
  }

  // -------------------------------------------------------------------------
  // 1. Metrics
  // -------------------------------------------------------------------------
  heading('1. KPI metrics');
  const metrics = await portalService.getMetrics();
  console.log('   ', metrics);
  if (metrics.totalStores < 1) throw new Error('Expected at least 1 store');
  ok('Metrics returned and at least one store is active.');

  // -------------------------------------------------------------------------
  // 2. Stores — real codes only
  // -------------------------------------------------------------------------
  heading('2. Stores');
  const stores = await portalService.getStores();
  console.log(`    ${stores.length} store(s)`);
  const bravo = stores.find((s) => s.store_code === EXPECTED_STORE_CODE);
  if (!bravo) {
    throw new Error(
      `Store ${EXPECTED_STORE_CODE} not found. Got: ${stores.map((s) => s.store_code).join(', ')}`,
    );
  }
  ok(`Found ${bravo.name} (${bravo.store_code}, ${bravo.city})`);
  ok('Store codes come from the database, not from a hardcoded demo list.');

  // -------------------------------------------------------------------------
  // 3. Tasks — and the template lookup behind them
  // -------------------------------------------------------------------------
  heading('3. Tasks');
  const tasks = await portalService.getTasks();
  console.log(`    ${tasks.length} store task(s)`);

  // A store task stores only (template, store, assignee, state). Title,
  // description and the checklist live on the template, so a task whose title is
  // "Şablon tapılmadı" means the server-side template join is broken — which the
  // panel would show as a row of blank cards.
  const orphaned = tasks.filter((t) => t.title === 'Şablon tapılmadı');
  if (tasks.length > 0 && orphaned.length === tasks.length) {
    throw new Error('Every task is missing its template — the template join is broken');
  }
  if (orphaned.length > 0) {
    console.log(`    ⚠ ${orphaned.length} task(s) could not resolve their template`);
  }
  const withTitle = tasks.filter((t) => t.title && t.title !== 'Şablon tapılmadı');
  if (withTitle.length > 0) ok(`Templates resolved, e.g. "${withTitle[0].title}"`);
  else ok('No dispatched tasks yet — nothing to resolve.');

  // -------------------------------------------------------------------------
  // 4. Submissions
  // -------------------------------------------------------------------------
  heading('4. Submissions');
  const submissions = await portalService.getSubmissions('all');
  console.log(`    ${submissions.length} submission(s)`);

  const counts = submissions.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log('   ', counts);

  // The verdict lives on the task, not on the evidence, so a submission's status
  // is derived server-side. Every submission must land in one of the three
  // values the panel knows how to render.
  const unknown = submissions.filter(
    (s) => !['pending_review', 'approved', 'rejected'].includes(s.status),
  );
  if (unknown.length > 0) {
    throw new Error(`Unmapped submission status(es): ${unknown.map((s) => s.status).join(', ')}`);
  }
  ok('Every submission carries a status the panel can render.');

  // -------------------------------------------------------------------------
  // 5. Write paths — opt-in only
  // -------------------------------------------------------------------------
  heading('5. Write paths');
  if (!RUN_WRITES) {
    console.log('    ⏭  SKIPPED — read-only mode.');
    console.log('       Set ONETEAM_SMOKE_WRITES=1 against a development database to run these.');
    console.log('       They are covered by `npm run test:core` and `npm run test:phase2`.');
  } else {
    const created = await portalService.createTask({
      title: 'Smoke test — Coca-Cola Zero 1L end-cap auditi',
      description: 'Avtomatik smoke test tərəfindən yaradılmış yoxlama tapşırığı.',
      reference_image_url: 'https://images.unsplash.com/photo-1554866585-cd94860890b7',
      priority: 'urgent',
      deadline: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
      assigned_stores: [bravo.id],
    });
    ok(`Created a briefing for ${bravo.store_code}: "${created.title}"`);

    const before = (await portalService.getTasks()).length;
    const bulk = await portalService.bulkDispatchTasks({
      title: 'Smoke test — kütləvi cooler auditi',
      description: 'Avtomatik smoke test tərəfindən yaradılmış kütləvi tapşırıq.',
      reference_image_url: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97',
      priority: 'high',
      deadline: new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString(),
      chainName: 'Bravo',
    });
    if (!bulk.success || bulk.count < 1) throw new Error('Bulk dispatch produced no tasks');
    ok(`Bulk dispatch matched ${bulk.count} store(s) in the Bravo chain`);

    const after = (await portalService.getTasks()).length;
    if (after <= before) {
      throw new Error(`Task count did not grow (${before} -> ${after})`);
    }
    ok(`Store task count grew ${before} -> ${after}`);

    const pending = submissions.find((s) => s.status === 'pending_review');
    if (!pending) {
      console.log('    ℹ Nothing is pending review — skipping the review paths.');
    } else {
      await portalService.oneClickAIApprove(pending.id);
      ok(`Auto-review ran on ${pending.id}`);

      const refreshed = await portalService.getSubmissions('all');
      const reviewed = refreshed.find((s) => s.id === pending.id);
      if (!reviewed || reviewed.status === 'pending_review') {
        throw new Error('Auto-review left the submission pending');
      }
      ok(`Verdict applied: ${reviewed.status}`);
    }
  }

  console.log('\n============================================================');
  console.log(
    `  PASSED (${RUN_WRITES ? 'read + write' : 'read-only'}) — the panel is reading the real API.`,
  );
  console.log('============================================================\n');
}

runWebSmokeTest().catch((err) => {
  console.error('\n❌ Web smoke test failed:', err?.message || err);
  console.error(
    '\n   If this is a connection error, the API is not running. Start it with:\n' +
      '     npm run api:dev\n',
  );
  process.exit(1);
});
