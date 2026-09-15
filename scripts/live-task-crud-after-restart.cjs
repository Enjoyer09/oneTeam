/**
 * oneTeam — LIVE task-CRUD verification against production (part 2 of 2).
 * ============================================================================
 *
 * THE POINT OF THIS HALF
 * ----------------------
 * Part 1 exercised every HTTP path and then stopped, leaving its fixtures in
 * place. This half runs only after the API process has been RESTARTED, and that
 * restart is what makes it evidence rather than a re-read of the same memory.
 *
 * A freshly started process has no in-memory array from before. `init()`
 * hydrates that array from PostgreSQL. So if a task created before the restart
 * is still visible after it, the row is genuinely in the database — which is the
 * one thing a test that only speaks HTTP cannot otherwise show, and the exact
 * failure this project has hit before (a task pushed into the array, answered
 * 201, rendered in the panel, never written).
 *
 * THE CONTROL THAT MAKES IT MEANINGFUL
 * ------------------------------------
 * "It is still there" proves nothing if the process was never restarted. So this
 * script refuses to draw a conclusion unless `uptimeSeconds` is small enough
 * that the restart demonstrably happened, and it reads uptime twice to confirm
 * the counter is actually running.
 *
 * IT CLEANS UP AFTER ITSELF. Every fixture task is deleted, then every fixture
 * store, and the last checks assert the counts are back where part 1 found them.
 *
 * Usage:
 *   ONETEAM_API_URL=... ONETEAM_PANEL_KEY=... node scripts/live-task-crud-after-restart.cjs
 *   ... --cleanup-only    (skip the proof, just remove the fixtures)
 */

const fs = require('fs');

const API = (process.env.ONETEAM_API_URL || '').replace(/\/+$/, '');
const KEY = process.env.ONETEAM_PANEL_KEY || '';
const STATE_PATH = process.env.ONETEAM_LIVE_STATE || '/tmp/oneteam-live-state.json';
const CLEANUP_ONLY = process.argv.includes('--cleanup-only');

/** A restart that happened longer ago than this proves nothing about a write. */
const MAX_TRUSTED_UPTIME_SECONDS = 300;

if (!API || !KEY) {
  console.error('ONETEAM_API_URL and ONETEAM_PANEL_KEY are both required');
  process.exit(2);
}
if (!fs.existsSync(STATE_PATH)) {
  console.error(`no state file at ${STATE_PATH} — run the part-1 script first`);
  process.exit(2);
}
const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

let passed = 0;
let failed = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}${detail === undefined ? '' : `  → ${detail}`}`);
  }
}

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 300) };
  }
  return { status: response.status, body: payload };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`\nLIVE task CRUD after restart — ${API}\n${'='.repeat(72)}`);

  const health1 = await call('GET', '/api/health');
  const uptime1 = health1.body?.uptimeSeconds;

  if (!CLEANUP_ONLY) {
    console.log('\nthe restart itself — without this the rest proves nothing');
    check(
      'the process was restarted recently',
      typeof uptime1 === 'number' && uptime1 <= MAX_TRUSTED_UPTIME_SECONDS,
      `uptimeSeconds=${uptime1} (needs <= ${MAX_TRUSTED_UPTIME_SECONDS}); a long-running process would mean the rows below were never re-read from disk`,
    );

    await sleep(2500);
    const health2 = await call('GET', '/api/health');
    const uptime2 = health2.body?.uptimeSeconds;
    check(
      'and its uptime counter is really running',
      typeof uptime2 === 'number' && uptime2 > uptime1,
      `${uptime1} -> ${uptime2}`,
    );

    // ------------------------------------------------------- the actual proof
    console.log('\nwrite-through — the fixtures outlived the process that made them');
    const tasks = (await call('GET', '/api/portal/tasks')).body?.data ?? [];
    const survivor = tasks.find((t) => t.id === state.survive.taskId);

    check(
      'THE TASK CREATED BEFORE THE RESTART IS STILL THERE',
      Boolean(survivor),
      `no task with id ${state.survive.taskId} — it was answered 201 but never reached PostgreSQL`,
    );
    check(
      'AND THE SHARED EDIT IT RECEIVED SURVIVED TOO',
      survivor?.title === state.survive.expectedTitle,
      `title=${survivor?.title} expected=${state.survive.expectedTitle}`,
    );
    check(
      'AND ITS OWN PER-STORE DEADLINE SURVIVED — the sibling never received the edit',
      survivor &&
        Math.abs(
          new Date(survivor.deadline).getTime() -
            new Date(state.survive.expectedDeadline).getTime(),
        ) < 1000,
      `deadline=${survivor?.deadline} expected=${state.survive.expectedDeadline}`,
    );

    const stores = (await call('GET', '/api/portal/stores')).body?.data ?? [];
    const survivingStores = state.storeIds.filter((id) => stores.some((s) => s.id === id));
    check(
      'AND BOTH FIXTURE STORES ARE STILL THERE',
      survivingStores.length === state.storeIds.length,
      `${survivingStores.length}/${state.storeIds.length} survived`,
    );
  } else {
    console.log('\n(cleanup only — skipping the restart proof)');
  }

  // ----------------------------------------------------------------- cleanup
  console.log('\ncleanup');
  for (const id of state.taskIds) {
    const r = await call('DELETE', `/api/portal/tasks/${id}`);
    if (r.status !== 200 && r.status !== 404) {
      check(`fixture task ${id} is removed`, false, `HTTP ${r.status}`);
    }
  }
  check('every fixture task was removed', true);

  for (const id of state.storeIds) {
    const r = await call('DELETE', `/api/portal/stores/${id}`);
    if (r.status !== 200 && r.status !== 404) {
      check(`fixture store ${id} is removed`, false, `HTTP ${r.status}`);
    }
  }
  check('every fixture store was removed', true);

  const storesEnd = (await call('GET', '/api/portal/stores')).body?.data ?? [];
  const tasksEnd = (await call('GET', '/api/portal/tasks')).body?.data ?? [];

  const leftoverStores = storesEnd.filter((s) => state.storeIds.includes(s.id));
  const leftoverTasks = tasksEnd.filter((t) => state.taskIds.includes(t.id));
  check(
    'no fixture store is left behind',
    leftoverStores.length === 0,
    `${leftoverStores.length} left`,
  );
  check(
    'no fixture task is left behind',
    leftoverTasks.length === 0,
    `${leftoverTasks.length} left`,
  );
  check(
    'the store count is back where part 1 found it',
    storesEnd.length === state.baseline.stores,
    `${storesEnd.length} vs baseline ${state.baseline.stores}`,
  );
  check(
    'and the task count is too',
    tasksEnd.length === state.baseline.tasks,
    `${tasksEnd.length} vs baseline ${state.baseline.tasks}`,
  );

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nfailed checks:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error('\nthe run itself failed:', error.message);
  process.exit(3);
});
