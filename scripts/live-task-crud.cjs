/**
 * oneTeam — LIVE task-CRUD verification against production (part 1 of 2).
 * ============================================================================
 *
 * WHY THIS EXISTS SEPARATELY FROM `test:tasks`
 * -------------------------------------------
 * The local suite is the better test: its load-bearing assertions read
 * PostgreSQL directly with a second connection, so it can prove a row landed
 * before the API answered. This script cannot do that — the production database
 * is on Railway's private network and is not reachable from a laptop.
 *
 * So this script proves what HTTP alone can prove, and then hands off: it leaves
 * its fixtures in place and writes their ids to a state file. Part 2 runs after
 * the API has been RESTARTED, and that restart is the actual proof of
 * write-through — a process that has just started has no memory of what this
 * script created, so anything still visible afterwards came out of PostgreSQL.
 *
 * That is the specific failure this project has already been bitten by: a task
 * pushed into the in-memory array, answered 201, rendered in the panel, and
 * never written. It looks correct until the next deploy.
 *
 * IT CLEANS UP, BUT ONLY IN PART 2. If part 2 never runs, the fixture stores and
 * tasks stay behind — deliberately, because they are the evidence.
 *
 * Usage:
 *   ONETEAM_API_URL=... ONETEAM_PANEL_KEY=... node scripts/live-task-crud.cjs
 */

const API = (process.env.ONETEAM_API_URL || '').replace(/\/+$/, '');
const KEY = process.env.ONETEAM_PANEL_KEY || '';
const STATE_PATH = process.env.ONETEAM_LIVE_STATE || '/tmp/oneteam-live-state.json';
const fs = require('fs');

if (!API || !KEY) {
  console.error('ONETEAM_API_URL and ONETEAM_PANEL_KEY are both required');
  process.exit(2);
}

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
  let payload;
  const text = await response.text();
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 300) };
  }
  return { status: response.status, body: payload };
}

/** The server's `deadline` is a timestamp; the panel's input is a local string. */
function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

const created = { storeIds: [], taskIds: [], templateIds: [] };

(async () => {
  console.log(`\nLIVE task CRUD against ${API}\n${'='.repeat(72)}`);

  // ---------------------------------------------------------------- identity
  console.log('\nidentity');
  const me = await call('GET', '/api/panel/me');
  check('the panel credential authenticates', me.status === 200, `HTTP ${me.status}`);
  check(
    'and it carries a role that may edit tasks',
    me.body?.data?.role === 'ADMIN' || me.body?.data?.role === 'SUPERVISOR',
    `role=${me.body?.data?.role}`,
  );

  // ---------------------------------------------------------------- baseline
  console.log('\nbaseline');
  const storesBefore = (await call('GET', '/api/portal/stores')).body?.data ?? [];
  const tasksBefore = (await call('GET', '/api/portal/tasks')).body?.data ?? [];
  console.log(`  stores=${storesBefore.length} tasks=${tasksBefore.length}`);

  const stamp = Date.now().toString(36);

  // ------------------------------------------------------------ fixture stores
  console.log('\nfixture stores');
  const mkStore = async (suffix, body) => {
    const r = await call('POST', '/api/portal/stores', body);
    if (r.status === 201 && r.body?.data?.id) created.storeIds.push(r.body.data.id);
    return r;
  };

  // Minimal body on purpose. The store feature's real bug was a field the panel
  // never sends being wrongly required, and the local suite's helper sent every
  // field — so only a minimal body could catch it.
  const s1 = await mkStore('a', {
    store_code: `LIVE_T_${stamp}_A`,
    name: `Canlı test mağaza A ${stamp}`,
    address: 'Test ünvanı 1, Bakı',
    latitude: 40.400215,
    longitude: 49.867301,
  });
  check('a store is created from a MINIMAL body', s1.status === 201, `HTTP ${s1.status}`);

  const s2 = await mkStore('b', {
    store_code: `LIVE_T_${stamp}_B`,
    name: `Canlı test mağaza B ${stamp}`,
    address: 'Test ünvanı 2, Bakı',
    latitude: 40.380001,
    longitude: 49.850001,
  });
  check(
    'and a second one, so sibling counts mean something',
    s2.status === 201,
    `HTTP ${s2.status}`,
  );

  const storeA = s1.body?.data?.id;
  const storeB = s2.body?.data?.id;

  // -------------------------------------------------------------- create task
  console.log('\ncreate — the minimal body the panel actually sends');
  const createdDeadline = isoDaysFromNow(7);
  const created1 = await call('POST', '/api/portal/tasks', {
    title: `Canlı yoxlama brifinqi ${stamp}`,
    description: 'Avtomatik canlı yoxlama',
    deadline: createdDeadline,
    assigned_stores: [storeA, storeB],
  });
  check('a task is created', created1.status === 201, `HTTP ${created1.status}`);
  check(
    'and dispatched to both stores',
    created1.body?.data?.tasksCreated === 2,
    `tasksCreated=${created1.body?.data?.tasksCreated} failures=${JSON.stringify(created1.body?.data?.failures)}`,
  );
  check('with no failures reported', !created1.body?.data?.failures);
  if (created1.body?.data?.templateId) created.templateIds.push(created1.body.data.templateId);
  for (const id of created1.body?.data?.taskIds ?? []) created.taskIds.push(id);

  // Duplicate store ids must not produce duplicate tasks.
  const dup = await call('POST', '/api/portal/tasks', {
    title: `Canlı dublikat yoxlaması ${stamp}`,
    description: '',
    deadline: isoDaysFromNow(7),
    assigned_stores: [storeA, storeA, storeB],
  });
  check(
    'a duplicated store id does not create a duplicated task',
    dup.body?.data?.tasksCreated === 2,
    `tasksCreated=${dup.body?.data?.tasksCreated}`,
  );
  if (dup.body?.data?.templateId) created.templateIds.push(dup.body.data.templateId);
  for (const id of dup.body?.data?.taskIds ?? []) created.taskIds.push(id);

  // ------------------------------------------------------------ derived kinds
  console.log('\nderived kinds — there is no task_type column');
  const withChecklist = await call('POST', '/api/portal/tasks', {
    title: `Çeklist brifinqi ${stamp}`,
    description: '',
    deadline: isoDaysFromNow(7),
    assigned_stores: [storeA],
    // No `id` on purpose: the server must mint one, or the field client cannot
    // key its answers and a re-submission would duplicate rows.
    checklist_schema: [{ label: 'Soyuducu temperaturu ölçülüb?' }],
  });
  if (withChecklist.body?.data?.templateId)
    created.templateIds.push(withChecklist.body.data.templateId);
  for (const id of withChecklist.body?.data?.taskIds ?? []) created.taskIds.push(id);

  const withPhoto = await call('POST', '/api/portal/tasks', {
    title: `Foto brifinqi ${stamp}`,
    description: '',
    deadline: isoDaysFromNow(7),
    assigned_stores: [storeA],
    requires_before_after_photo: true,
  });
  if (withPhoto.body?.data?.templateId) created.templateIds.push(withPhoto.body.data.templateId);
  for (const id of withPhoto.body?.data?.taskIds ?? []) created.taskIds.push(id);

  const after = (await call('GET', '/api/portal/tasks')).body?.data ?? [];
  const mine = after.filter((t) => created.taskIds.includes(t.id));
  const auditTask = mine.find((t) => t.id === created.taskIds[0]);
  const checklistTask = mine.find((t) => t.title?.startsWith('Çeklist brifinqi'));
  const photoTask = mine.find((t) => t.title?.startsWith('Foto brifinqi'));

  check(
    'the minimal task derives as AUDIT',
    auditTask?.kind === 'AUDIT',
    `kind=${auditTask?.kind}`,
  );
  check(
    'a checklist task derives as CHECKLIST',
    checklistTask?.kind === 'CHECKLIST',
    `kind=${checklistTask?.kind}`,
  );
  check(
    'a before/after task derives as PHOTO',
    photoTask?.kind === 'PHOTO',
    `kind=${photoTask?.kind}`,
  );
  // The read direction speaks lower case and the write direction accepts either.
  // `toPanelTask` lower-cases on the way out because the panel's own
  // `TaskPriority` is `'low' | 'medium' | 'high' | 'urgent'`, while `readPriority`
  // upper-cases on the way in and refuses anything outside the enum. An earlier
  // version of this script asserted `'MEDIUM'` on the read and reported a failure
  // that was the script's fault, not the API's.
  check(
    'an omitted priority defaults to MEDIUM (read back lower-cased)',
    auditTask?.priority === 'medium',
    `priority=${auditTask?.priority}`,
  );

  // The other half of that contract: the write direction is case-insensitive.
  const lowerCasePriority = await call('POST', '/api/portal/tasks', {
    title: `Kiçik hərfli prioritet ${stamp}`,
    description: '',
    deadline: isoDaysFromNow(7),
    priority: 'high',
    assigned_stores: [storeA],
  });
  if (lowerCasePriority.body?.data?.templateId)
    created.templateIds.push(lowerCasePriority.body.data.templateId);
  for (const id of lowerCasePriority.body?.data?.taskIds ?? []) created.taskIds.push(id);
  const lowerRead = (await call('GET', '/api/portal/tasks')).body?.data ?? [];
  const lowerTask = lowerRead.find((t) => t.id === lowerCasePriority.body?.data?.taskIds?.[0]);
  check(
    'and a lower-case priority on the way in is accepted and normalised',
    lowerCasePriority.status === 201 && lowerTask?.priority === 'high',
    `HTTP ${lowerCasePriority.status} priority=${lowerTask?.priority}`,
  );
  check(
    'a checklist item without an id is given one',
    typeof checklistTask?.checklist_schema?.[0]?.id === 'string' &&
      checklistTask.checklist_schema[0].id.length > 0,
    JSON.stringify(checklistTask?.checklist_schema?.[0]),
  );
  check(
    'sibling_task_count reports the two stores it reached',
    auditTask?.sibling_task_count === 2,
    `sibling_task_count=${auditTask?.sibling_task_count}`,
  );
  check(
    'and the task carries the store and template it belongs to',
    Boolean(auditTask?.store_id) && Boolean(auditTask?.template_id),
    `store_id=${auditTask?.store_id} template_id=${auditTask?.template_id}`,
  );

  // --------------------------------------------------------------- refusals
  console.log('\nrefusals');
  const base = {
    title: 'x',
    description: '',
    deadline: isoDaysFromNow(7),
    assigned_stores: [storeA],
  };

  const blankTitle = await call('POST', '/api/portal/tasks', { ...base, title: '   ' });
  check(
    'a blank title is refused with 400',
    blankTitle.status === 400,
    `HTTP ${blankTitle.status}`,
  );

  const badDate = await call('POST', '/api/portal/tasks', { ...base, deadline: 'sabah' });
  check(
    'a deadline that is not a date is refused with 400',
    badDate.status === 400,
    `HTTP ${badDate.status}`,
  );

  const badPriority = await call('POST', '/api/portal/tasks', { ...base, priority: 'SUPER' });
  check(
    'a priority outside the enum is refused with 400',
    badPriority.status === 400,
    `HTTP ${badPriority.status}`,
  );

  const badChecklist = await call('POST', '/api/portal/tasks', {
    ...base,
    checklist_schema: 'sual',
  });
  check(
    'a checklist that is not a list is refused with 400',
    badChecklist.status === 400,
    `HTTP ${badChecklist.status}`,
  );

  const emptyItem = await call('POST', '/api/portal/tasks', {
    ...base,
    checklist_schema: [{ label: '   ' }],
  });
  check(
    'a checklist item with no question is refused with 400',
    emptyItem.status === 400,
    `HTTP ${emptyItem.status}`,
  );

  const unknownStore = await call('POST', '/api/portal/tasks', {
    ...base,
    assigned_stores: ['str-does-not-exist-live'],
  });
  check(
    'an unknown store is refused with 503, not a 200 saying "0 created"',
    unknownStore.status === 503,
    `HTTP ${unknownStore.status}`,
  );
  check(
    'and the refusal names which store failed and why',
    Array.isArray(unknownStore.body?.failures) && unknownStore.body.failures.length > 0,
    JSON.stringify(unknownStore.body?.failures),
  );

  // ------------------------------------------------------- orphan templates
  console.log('\nrefused creates must not leave a template behind');
  const tasksAfterRefusals = (await call('GET', '/api/portal/tasks')).body?.data ?? [];
  const orphans = tasksAfterRefusals.filter(
    (t) => ['x', ''].includes(t.title) && t.store_id !== undefined,
  );
  check(
    'no task exists for any refused create',
    orphans.filter((t) => t.title === 'x').length === 0,
    `${orphans.length} stray task(s)`,
  );

  // ------------------------------------------------------------------ edits
  console.log('\nedit — the two halves of a task');
  const taskA = created.taskIds[0];
  const taskB = created.taskIds[1];
  const newDeadline = isoDaysFromNow(3);

  const deadlineEdit = await call('PATCH', `/api/portal/tasks/${taskA}`, { deadline: newDeadline });
  check('a deadline edit is accepted', deadlineEdit.status === 200, `HTTP ${deadlineEdit.status}`);

  const afterDeadline = (await call('GET', '/api/portal/tasks')).body?.data ?? [];
  const readA = afterDeadline.find((t) => t.id === taskA);
  const readB = afterDeadline.find((t) => t.id === taskB);
  check(
    'and the new deadline is what the panel reads back',
    readA && Math.abs(new Date(readA.deadline).getTime() - new Date(newDeadline).getTime()) < 1000,
    `read=${readA?.deadline} wrote=${newDeadline}`,
  );
  check(
    'and the SIBLING store kept its own deadline',
    readB && Math.abs(new Date(readB.deadline).getTime() - new Date(newDeadline).getTime()) > 1000,
    `sibling deadline=${readB?.deadline}`,
  );

  const newTitle = `Redaktə olunmuş başlıq ${stamp}`;
  const titleEdit = await call('PATCH', `/api/portal/tasks/${taskA}`, { title: newTitle });
  check('a title edit is accepted', titleEdit.status === 200, `HTTP ${titleEdit.status}`);
  check(
    'and the response says how many tasks the shared edit reached',
    titleEdit.body?.templateEditReachedTasks === 2,
    `templateEditReachedTasks=${titleEdit.body?.templateEditReachedTasks}`,
  );

  const afterTitle = (await call('GET', '/api/portal/tasks')).body?.data ?? [];
  const siblingTitle = afterTitle.find((t) => t.id === taskB)?.title;
  check(
    'AND THE SIBLING REALLY SHOWS THE NEW TITLE — the briefing is shared, not copied',
    siblingTitle === newTitle,
    `sibling title=${siblingTitle}`,
  );

  const badEdit = await call('PATCH', `/api/portal/tasks/${taskA}`, { deadline: 'sabah' });
  check(
    'an invalid deadline edit is refused with 400',
    badEdit.status === 400,
    `HTTP ${badEdit.status}`,
  );

  const missingEdit = await call('PATCH', '/api/portal/tasks/task-does-not-exist', {
    deadline: newDeadline,
  });
  check(
    'editing an unknown task answers 404',
    missingEdit.status === 404,
    `HTTP ${missingEdit.status}`,
  );

  // ---------------------------------------------------------------- deletes
  console.log('\ndelete');
  const delOne = await call('DELETE', `/api/portal/tasks/${taskA}`);
  check('deleting one task answers 200', delOne.status === 200, `HTTP ${delOne.status}`);
  const delAgain = await call('DELETE', `/api/portal/tasks/${taskA}`);
  check(
    'deleting it a second time answers 404',
    delAgain.status === 404,
    `HTTP ${delAgain.status}`,
  );
  const missingDelete = await call('DELETE', '/api/portal/tasks/task-does-not-exist');
  check(
    'deleting an unknown id answers 404',
    missingDelete.status === 404,
    `HTTP ${missingDelete.status}`,
  );

  // The sibling must survive its partner's deletion — they are separate rows.
  const afterDelete = (await call('GET', '/api/portal/tasks')).body?.data ?? [];
  check(
    'AND THE SIBLING STORE STILL HAS ITS TASK',
    afterDelete.some((t) => t.id === taskB),
    'the sibling disappeared with its partner — the rows are not independent',
  );

  // ------------------------------------------------------------- hand-off
  const state = {
    api: API,
    storeIds: created.storeIds,
    taskIds: created.taskIds.filter((id) => id !== taskA),
    templateIds: created.templateIds,
    baseline: {
      stores: storesBefore.length,
      tasks: tasksBefore.length,
    },
    // What part 2 must find still standing after the restart.
    //
    // `taskB` is the SIBLING: the deadline edit was applied to `taskA` only, so
    // the value to expect here is the one taskB was CREATED with. An earlier
    // version of this file stored the edited deadline and reported a failure
    // after the restart — the API had done exactly the right thing, keeping the
    // two stores' deadlines independent across a process boundary, and the
    // script was the thing that was wrong.
    survive: {
      taskId: taskB,
      expectedTitle: newTitle,
      expectedDeadline: createdDeadline,
      // The edited task is deleted during part 1, so this is the only one left.
      editedTaskId: taskA,
    },
    storeIdsToDelete: created.storeIds,
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`\nstate written to ${STATE_PATH}`);
  console.log(
    `  ${state.taskIds.length} fixture task(s), ${state.storeIds.length} fixture store(s)`,
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
  console.error(JSON.stringify(created, null, 2));
  process.exit(3);
});
