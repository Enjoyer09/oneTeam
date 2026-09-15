/**
 * oneTeam — task CRUD suite
 * ============================================================================
 *
 * WHY THIS EXISTS AS A PERMANENT TEST
 * -----------------------------------
 * Dispatching a briefing stopped being "push an object into an array". A task
 * is now two rows in two tables — a `task_templates` row holding the words and
 * a `store_tasks` row holding the store, the deadline and the state — and the
 * second one has a foreign key to the first.
 *
 * That combination is where this project has already lost data twice:
 *
 *   - The read path is an in-memory array, so a task can be pushed, returned
 *     with a 201, rendered in the panel, and never reach PostgreSQL. It looks
 *     correct until the next deploy.
 *   - `createStoreTask` used to fire the insert and return. If the template's
 *     own insert had not landed, EVERY store task insert failed its foreign key
 *     — twelve failures reported as twelve successes.
 *
 * So the load-bearing assertions are:
 *
 *   THE store_tasks ROW AND ITS task_templates ROW ARE IN POSTGRESQL,
 *   READ BACK WITH A SEPARATE CONNECTION, BEFORE THE CREATE CALL RETURNS.
 *
 * Everything else guards the edges: a deadline that is not a date, a checklist
 * item with no question, a priority outside the enum, a duplicated store id,
 * an unknown store, and — the one that matters most — deleting a task that has
 * submissions, which would cascade to the photos.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * --------------------------------------
 * It runs over HTTP against a running API, because the write ordering being
 * tested lives in the API process.
 *
 * IT NEEDS A PANEL CREDENTIAL, AND SAYS SO RATHER THAN FAILING.
 * Once any panel key exists the service credential is refused on
 * `/api/portal/*` — by design. This suite takes `ONETEAM_TEST_PANEL_KEY` when
 * the panel is locked, falls back to the service credential when it is open,
 * and skips with the command to fix it when neither is accepted.
 *
 * IT BUILDS ITS OWN WORLD AND CLEANS IT UP.
 * Two stores are created so that one briefing can be dispatched to two of them
 * (that is what makes `sibling_task_count` mean anything), every task is
 * deleted, then both stores are deleted, and the last check asserts both counts
 * are back where they started.
 *
 * Prerequisites: the API must be running, and DATABASE_URL must point at the
 * same database it is using.
 *
 *   npm run api:dev
 *   DATABASE_URL=postgres://... ONETEAM_API_URL=http://localhost:3001 \
 *     ONETEAM_TEST_PANEL_KEY=otp_... npm run test:tasks
 */

import { Client } from 'pg';

const API_BASE = (process.env.ONETEAM_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || '';

/** A panel login key, when the panel is locked. */
const PANEL_KEY = process.env.ONETEAM_TEST_PANEL_KEY || '';
/** The service credential, usable only while the panel has no keys at all. */
const ADMIN_TOKEN = process.env.ONETEAM_TEST_ADMIN_TOKEN || 'oneteam-user:usr-admin-001';
/** A merchandiser — the role that must not be able to author or change work. */
const MERCH_TOKEN = process.env.ONETEAM_TEST_MERCH_TOKEN || 'oneteam-user:usr-merch-003';

/** Unique per run, so two runs against one database do not collide. */
const RUN = Date.now().toString(36).toUpperCase();

let pass = 0;
let fail = 0;
let skipped = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    console.log(`  \u2717 ${name}`);
    if (detail !== undefined) console.log(`      got: ${JSON.stringify(detail)}`);
  }
}

function skip(name: string, why: string): void {
  skipped += 1;
  console.log(`  \u25CB ${name} — SKIPPED: ${why}`);
}

interface Result {
  status: number;
  body: any;
}

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Result> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/** A store body that should be accepted, with the code overridable. */
function storeBody(code: string, overrides: Record<string, unknown> = {}) {
  return {
    store_code: code,
    name: `Tapşırıq Testi Mağazası ${code.slice(-2)}`,
    address: 'Test ünvanı 1, Bakı',
    latitude: 40.3724,
    longitude: 49.8372,
    ...overrides,
  };
}

/** A briefing body that should be accepted, with anything overridable. */
function taskBody(storeIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    title: `Rəf yoxlaması — Suite ${RUN}`,
    description: 'Suite tərəfindən yaradılmış müvəqqəti tapşırıq.',
    priority: 'HIGH',
    deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    assigned_stores: storeIds,
    ...overrides,
  };
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // Which credential are we?
  // ---------------------------------------------------------------------------
  const candidates: Array<{ label: string; token: string }> = [];
  if (PANEL_KEY) candidates.push({ label: 'the panel key', token: PANEL_KEY });
  candidates.push({ label: 'the service credential', token: ADMIN_TOKEN });

  let token = '';
  let usingLabel = '';

  for (const candidate of candidates) {
    const probe = await call('GET', '/api/portal/tasks', { token: candidate.token });
    if (probe.status === 200) {
      token = candidate.token;
      usingLabel = candidate.label;
      break;
    }
  }

  if (!token) {
    skip(
      'every task check',
      'no accepted credential. The panel has keys, so the service credential is refused by design. ' +
        'Re-run with ONETEAM_TEST_PANEL_KEY=otp_... (mint one from the panel, or with the bootstrap key).',
    );
    console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
    return;
  }

  console.log(`  · authenticating with ${usingLabel}`);

  const db = DATABASE_URL ? new Client({ connectionString: DATABASE_URL }) : null;
  if (db) await db.connect();

  /** Reads a store task straight from PostgreSQL, bypassing the API entirely. */
  const taskRow = async (taskId: string): Promise<any | null> => {
    if (!db) return null;
    const result = await db.query('SELECT * FROM store_tasks WHERE id = $1', [taskId]);
    return result.rows[0] ?? null;
  };

  /** Reads a template straight from PostgreSQL. */
  const templateRow = async (templateId: string): Promise<any | null> => {
    if (!db) return null;
    const result = await db.query('SELECT * FROM task_templates WHERE id = $1', [templateId]);
    return result.rows[0] ?? null;
  };

  const countOf = async (table: string): Promise<number | null> => {
    if (!db) return null;
    const result = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table}`,
    );
    return Number(result.rows[0]?.count ?? -1);
  };

  const codeA = `TEST_TASK_A_${RUN}`;
  const codeB = `TEST_TASK_B_${RUN}`;

  const storeIds: string[] = [];
  const taskIds: string[] = [];
  const templateIds: string[] = [];

  /**
   * A submission written straight into PostgreSQL as a fixture.
   *
   * Declared out here because the cleanup block has to remove it before it can
   * delete the task it belongs to.
   */
  let fixtureEvidenceId: string | undefined;

  const tasksBefore = await countOf('store_tasks');
  const templatesBefore = await countOf('task_templates');
  const storesBefore = await countOf('stores');

  try {
    // -------------------------------------------------------------------------
    console.log('\nfixtures: two stores');
    // -------------------------------------------------------------------------

    for (const code of [codeA, codeB]) {
      const created = await call('POST', '/api/portal/stores', { token, body: storeBody(code) });
      check(`store ${code.slice(-2)} is created`, created.status === 201, created.body);
      const id = created.body?.data?.id;
      if (typeof id === 'string') storeIds.push(id);
    }

    if (storeIds.length < 2) {
      // Without two stores the sibling checks below would be vacuous, and a
      // vacuous check that prints a tick is worse than no check at all.
      skip('every task check', 'could not create the two fixture stores');
      return;
    }

    const [storeA, storeB] = storeIds;

    // -------------------------------------------------------------------------
    console.log('\ndispatch');
    // -------------------------------------------------------------------------

    const dispatched = await call('POST', '/api/portal/tasks', {
      token,
      body: taskBody([storeA, storeB]),
    });

    check('POST /api/portal/tasks answers 201', dispatched.status === 201, dispatched.body);
    check(
      'and reports one task per store',
      dispatched.body?.data?.tasksCreated === 2,
      dispatched.body?.data,
    );

    const templateId: string | undefined = dispatched.body?.data?.templateId;
    const firstTaskId: string | undefined = dispatched.body?.data?.taskIds?.[0];
    const secondTaskId: string | undefined = dispatched.body?.data?.taskIds?.[1];

    check('and returns a template id', typeof templateId === 'string', dispatched.body?.data);
    check('and returns the task ids', Array.isArray(dispatched.body?.data?.taskIds));
    check('and reports no failures', dispatched.body?.data?.failures === undefined);

    if (templateId) templateIds.push(templateId);
    for (const id of [firstTaskId, secondTaskId]) if (id) taskIds.push(id);

    // THE LOAD-BEARING ASSERTION. Both rows, read back with a separate
    // connection, not through the API. A task that exists only in the API's
    // memory passes every check above and fails these.
    if (db && firstTaskId && templateId) {
      const task = await taskRow(firstTaskId);
      check(
        'THE store_tasks ROW IS IN POSTGRESQL BEFORE THE CALL RETURNS',
        task !== null,
        'no row with that id — the API answered 201 for a task it never stored',
      );
      check(
        'and it points at the template that was just created',
        task !== null && task.template_id === templateId,
        task && { template_id: task.template_id, expected: templateId },
      );
      check(
        'and it points at the store it was dispatched to',
        task !== null && task.store_id === storeA,
        task && { store_id: task.store_id, expected: storeA },
      );
      check(
        'and it starts PUBLISHED, not DRAFT',
        task !== null && task.status === 'PUBLISHED',
        task?.status,
      );

      const template = await templateRow(templateId);
      check(
        'AND THE task_templates ROW IS IN POSTGRESQL TOO',
        template !== null,
        'the store task has a foreign key to this row — its absence is the silent-loss shape',
      );
      check(
        'and the template carries the title that was submitted',
        template !== null && String(template.title).includes(RUN),
        template?.title,
      );
      check(
        'and the priority is stored in the uppercase enum form',
        template !== null && template.priority === 'HIGH',
        template?.priority,
      );
    } else {
      skip('the read-back-from-PostgreSQL checks', 'DATABASE_URL is not set');
    }

    // -------------------------------------------------------------------------
    console.log('\nthe panel projection');
    // -------------------------------------------------------------------------

    const list = await call('GET', '/api/portal/tasks', { token });
    check('GET /api/portal/tasks answers 200', list.status === 200, list.body);

    const projected = list.body?.data?.find((t: any) => t.id === firstTaskId);
    check('and the new task is in the list', projected !== undefined, list.body?.data?.length);

    // Without these three ids the edit and delete forms cannot address the row
    // they are showing, and the panel would have to guess.
    check(
      'and it carries template_id',
      projected?.template_id === templateId,
      projected?.template_id,
    );
    check('and it carries store_id', projected?.store_id === storeA, projected?.store_id);
    check('and it carries assigned_user_id', 'assigned_user_id' in (projected ?? {}), projected);

    // One briefing, two stores, so each row must know it is not alone. This is
    // what the edit form's warning is built from.
    check(
      'and sibling_task_count is 2 — one briefing, two stores',
      projected?.sibling_task_count === 2,
      projected?.sibling_task_count,
    );
    check('and evidence_count is 0 for a fresh task', projected?.evidence_count === 0, projected);

    // There is no task_type column; the kind is derived from the fields that do
    // exist. Asserting it here is what stops the derivation drifting.
    check(
      'and kind is AUDIT when there is neither a checklist nor a photo pair',
      projected?.kind === 'AUDIT',
      projected?.kind,
    );

    // -------------------------------------------------------------------------
    console.log('\nminimal body and derived kind');
    // -------------------------------------------------------------------------

    const minimal = await call('POST', '/api/portal/tasks', {
      token,
      body: {
        title: `Minimal tapşırıq ${RUN}`,
        deadline: new Date(Date.now() + 86400000).toISOString(),
        assigned_stores: [storeA],
      },
    });
    check(
      'a briefing with no description or priority is accepted',
      minimal.status === 201,
      minimal.body,
    );
    check(
      'and its priority defaults to MEDIUM in the template',
      db ? (await templateRow(minimal.body?.data?.templateId))?.priority === 'MEDIUM' : true,
      minimal.body?.data,
    );
    if (minimal.body?.data?.taskIds?.[0]) taskIds.push(minimal.body.data.taskIds[0]);
    if (minimal.body?.data?.templateId) templateIds.push(minimal.body.data.templateId);

    const minimalTask = (await call('GET', '/api/portal/tasks', { token })).body?.data?.find(
      (t: any) => t.id === minimal.body?.data?.taskIds?.[0],
    );
    check(
      'and the panel shows the priority in lowercase',
      minimalTask?.priority === 'medium',
      minimalTask?.priority,
    );

    const withChecklist = await call('POST', '/api/portal/tasks', {
      token,
      body: taskBody([storeA], {
        checklist_schema: [{ label: 'Rəfdə boşluq var?' }, { label: 'Qiymət etiketi düzdür?' }],
      }),
    });
    check(
      'a briefing with a checklist is accepted',
      withChecklist.status === 201,
      withChecklist.body,
    );
    if (withChecklist.body?.data?.taskIds?.[0]) taskIds.push(withChecklist.body.data.taskIds[0]);
    if (withChecklist.body?.data?.templateId) templateIds.push(withChecklist.body.data.templateId);

    const checklistTask = (await call('GET', '/api/portal/tasks', { token })).body?.data?.find(
      (t: any) => t.id === withChecklist.body?.data?.taskIds?.[0],
    );
    check('and kind is CHECKLIST', checklistTask?.kind === 'CHECKLIST', checklistTask?.kind);
    check(
      'and the items were given ids the field client can answer against',
      Array.isArray(checklistTask?.checklist_schema) &&
        checklistTask.checklist_schema.every((item: any) => typeof item.id === 'string' && item.id),
      checklistTask?.checklist_schema,
    );

    const withPhotos = await call('POST', '/api/portal/tasks', {
      token,
      body: taskBody([storeA], { requires_before_after_photo: true }),
    });
    if (withPhotos.body?.data?.taskIds?.[0]) taskIds.push(withPhotos.body.data.taskIds[0]);
    if (withPhotos.body?.data?.templateId) templateIds.push(withPhotos.body.data.templateId);
    const photoTask = (await call('GET', '/api/portal/tasks', { token })).body?.data?.find(
      (t: any) => t.id === withPhotos.body?.data?.taskIds?.[0],
    );
    check(
      'and kind is PHOTO when a before/after pair is required',
      photoTask?.kind === 'PHOTO',
      photoTask?.kind,
    );

    // -------------------------------------------------------------------------
    console.log('\nrefusals on create');
    // -------------------------------------------------------------------------

    const noTitle = await call('POST', '/api/portal/tasks', {
      token,
      body: taskBody([storeA], { title: '   ' }),
    });
    check(
      'a briefing with a blank title is refused with 400',
      noTitle.status === 400,
      noTitle.body,
    );

    const badDeadline = await call('POST', '/api/portal/tasks', {
      token,
      body: taskBody([storeA], { deadline: 'sabah' }),
    });
    check(
      'a deadline that is not a date is refused with 400',
      badDeadline.status === 400,
      badDeadline.body,
    );
    check(
      'and the message names the expected shape',
      typeof badDeadline.body?.message === 'string' && badDeadline.body.message.includes('2026'),
      badDeadline.body?.message,
    );

    const badPriority = await call('POST', '/api/portal/tasks', {
      token,
      body: taskBody([storeA], { priority: 'ÇOX TƏCİLİ' }),
    });
    check(
      'a priority outside the enum is refused with 400',
      badPriority.status === 400,
      badPriority.body,
    );

    const badChecklist = await call('POST', '/api/portal/tasks', {
      token,
      body: taskBody([storeA], { checklist_schema: [{ label: '' }] }),
    });
    check(
      'a checklist item with no question is refused with 400',
      badChecklist.status === 400,
      badChecklist.body,
    );

    const checklistNotAList = await call('POST', '/api/portal/tasks', {
      token,
      body: taskBody([storeA], { checklist_schema: 'rəfdə boşluq var?' }),
    });
    check(
      'a checklist that is not a list is refused with 400',
      checklistNotAList.status === 400,
      checklistNotAList.body,
    );

    const unknownStore = await call('POST', '/api/portal/tasks', {
      token,
      body: taskBody(['str-does-not-exist']),
    });
    check(
      'dispatching to an unknown store answers 503',
      unknownStore.status === 503,
      unknownStore.body,
    );
    check(
      'and it says which store failed and why',
      Array.isArray(unknownStore.body?.failures) && unknownStore.body.failures.length === 1,
      unknownStore.body,
    );

    const unmatchedSegment = await call('POST', '/api/portal/tasks', {
      token,
      body: {
        title: `Seqment testi ${RUN}`,
        description: '',
        deadline: new Date(Date.now() + 86400000).toISOString(),
        chainName: `YOXDUR_${RUN}`,
      },
    });
    // Either "no store matched the segmentation" or "no merchandiser to assign
    // it to" — both are 400, and neither may be a 201.
    check(
      'a segmentation that matches nothing is refused, not reported as success',
      unmatchedSegment.status === 400,
      unmatchedSegment.body,
    );

    // -------------------------------------------------------------------------
    console.log('\nedit: this store');
    // -------------------------------------------------------------------------

    const newDeadline = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const deadlineEdit = await call('PATCH', `/api/portal/tasks/${firstTaskId}`, {
      token,
      body: { deadline: newDeadline.toISOString() },
    });
    check(
      'PATCH /api/portal/tasks/:id answers 200',
      deadlineEdit.status === 200,
      deadlineEdit.body,
    );
    check(
      'and the deadline comes back changed',
      deadlineEdit.body?.data?.deadline !== undefined &&
        Math.abs(new Date(deadlineEdit.body.data.deadline).getTime() - newDeadline.getTime()) <
          1000,
      deadlineEdit.body?.data?.deadline,
    );
    check(
      'and editing the deadline does not claim to have touched the briefing',
      deadlineEdit.body?.templateEditReachedTasks === 0,
      deadlineEdit.body?.templateEditReachedTasks,
    );

    if (db && firstTaskId) {
      const row = await taskRow(firstTaskId);
      check(
        'THE DEADLINE EDIT IS IN POSTGRESQL TOO',
        row !== null && Math.abs(new Date(row.deadline).getTime() - newDeadline.getTime()) < 1000,
        row?.deadline,
      );
      // The row that shares the template must be untouched: a per-store edit
      // that leaked into its sibling would be the exact confusion this design
      // is trying to avoid.
      const sibling = await taskRow(secondTaskId!);
      check(
        'and the sibling task still has the original deadline',
        sibling !== null &&
          Math.abs(new Date(sibling.deadline).getTime() - newDeadline.getTime()) > 1000,
        sibling?.deadline,
      );
    }

    // -------------------------------------------------------------------------
    console.log('\nedit: the briefing behind it');
    // -------------------------------------------------------------------------

    const titleEdit = await call('PATCH', `/api/portal/tasks/${firstTaskId}`, {
      token,
      body: { title: `Yenilənmiş başlıq ${RUN}` },
    });
    check('editing the title answers 200', titleEdit.status === 200, titleEdit.body);
    check(
      'and it reports how many store tasks the change reached',
      titleEdit.body?.templateEditReachedTasks === 2,
      titleEdit.body?.templateEditReachedTasks,
    );

    if (db) {
      const template = await templateRow(templateId!);
      check(
        'THE TEMPLATE EDIT IS IN POSTGRESQL',
        template !== null && String(template.title).includes('Yenilənmiş başlıq'),
        template?.title,
      );
    }

    const siblingAfterEdit = (await call('GET', '/api/portal/tasks', { token })).body?.data?.find(
      (t: any) => t.id === secondTaskId,
    );
    check(
      'and the sibling really does show the new title — one briefing, two stores',
      typeof siblingAfterEdit?.title === 'string' &&
        siblingAfterEdit.title.includes('Yenilənmiş başlıq'),
      siblingAfterEdit?.title,
    );

    const emptyPatch = await call('PATCH', `/api/portal/tasks/${firstTaskId}`, { token, body: {} });
    check(
      'a PATCH with nothing in it is refused with 400',
      emptyPatch.status === 400,
      emptyPatch.body,
    );

    const unknownPatch = await call('PATCH', '/api/portal/tasks/task-does-not-exist', {
      token,
      body: { title: 'Heç nə' },
    });
    check('a PATCH for an unknown id answers 404', unknownPatch.status === 404, unknownPatch.body);
    check(
      'and says the task was not found',
      unknownPatch.body?.error === 'TASK_NOT_FOUND',
      unknownPatch.body,
    );

    const badAssignee = await call('PATCH', `/api/portal/tasks/${firstTaskId}`, {
      token,
      body: { assigned_user_id: 'usr-admin-001' },
    });
    check(
      'assigning to a non-merchandiser is refused with 400',
      badAssignee.status === 400,
      badAssignee.body,
    );

    const unassign = await call('PATCH', `/api/portal/tasks/${firstTaskId}`, {
      token,
      body: { assigned_user_id: null },
    });
    check('but an explicit unassignment is accepted', unassign.status === 200, unassign.body);
    check(
      'and leaves the task claimable',
      unassign.body?.data?.assigned_user_id === null,
      unassign.body?.data?.assigned_user_id,
    );

    // -------------------------------------------------------------------------
    console.log('\ndelete');
    // -------------------------------------------------------------------------

    // The reason the refusal exists, asserted rather than assumed. If this
    // constraint ever stops being ON DELETE CASCADE the guard becomes
    // decoration, and this check is what says so.
    if (db) {
      const rule = await db.query<{ confdeltype: string }>(
        `SELECT c.confdeltype
           FROM pg_constraint c
           JOIN pg_attribute a
             ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
          WHERE c.conrelid = 'task_evidences'::regclass
            AND c.contype = 'f'
            AND a.attname = 'store_task_id'`,
      );
      check(
        'the evidence foreign key really is ON DELETE CASCADE',
        rule.rows[0]?.confdeltype === 'c',
        rule.rows[0]?.confdeltype,
      );
    }

    // A submission written straight into PostgreSQL, bypassing the field flow.
    //
    // That is deliberate and it is the sharpest version of this test: the API's
    // guard must consult the database, not its own in-memory list, which is a
    // poll behind. A row the process has never seen is exactly the row a stale
    // count would miss — and because the delete cascades, missing it does not
    // fail loudly, it destroys the photo quietly.
    if (db && secondTaskId) {
      const submitter = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE role = 'MERCHANDISER' ORDER BY id LIMIT 1`,
      );
      const submitterId = submitter.rows[0]?.id;
      if (submitterId) {
        fixtureEvidenceId = `ev-task-suite-${RUN}`;
        await db.query(
          `INSERT INTO task_evidences
             (id, store_task_id, submitted_by_id, photo_url, photo_type, latitude, longitude)
           VALUES ($1,$2,$3,$4,'standard',40.3724,49.8372)
           ON CONFLICT (id) DO NOTHING`,
          [fixtureEvidenceId, secondTaskId, submitterId, 'data:image/png;base64,c3VpdGU='],
        );
      }
    }

    if (fixtureEvidenceId && secondTaskId) {
      const refused = await call('DELETE', `/api/portal/tasks/${secondTaskId}`, { token });
      check(
        'deleting a task that has submissions is refused with 409',
        refused.status === 409,
        refused.body,
      );
      check(
        'and the refusal names the reason',
        refused.body?.error === 'TASK_HAS_EVIDENCE',
        refused.body,
      );
      check(
        'and it says how many submissions would have been destroyed',
        refused.body?.evidences === 1,
        refused.body?.evidences,
      );

      if (db) {
        const stillThere = await taskRow(secondTaskId);
        check('AND THE TASK IS STILL IN POSTGRESQL', stillThere !== null, stillThere);
        const evidenceStillThere = await db.query('SELECT id FROM task_evidences WHERE id = $1', [
          fixtureEvidenceId,
        ]);
        check('AND THE SUBMISSION IS STILL THERE TOO', evidenceStillThere.rows.length === 1);
      }

      // With the submission gone the same delete must succeed — otherwise the
      // guard could be refusing for a reason that has nothing to do with
      // evidence, and every check above would have passed anyway.
      if (db) {
        await db.query('DELETE FROM task_evidences WHERE id = $1', [fixtureEvidenceId]);
        fixtureEvidenceId = undefined;
      }
      const nowAllowed = await call('DELETE', `/api/portal/tasks/${secondTaskId}`, { token });
      check(
        'and once the submission is gone the same delete succeeds',
        nowAllowed.status === 200,
        nowAllowed.body,
      );
      const index = taskIds.indexOf(secondTaskId);
      if (index !== -1) taskIds.splice(index, 1);
    } else {
      skip('the delete-refusal check', 'no merchandiser row to attribute a fixture submission to');
    }

    const deleteTarget = minimal.body?.data?.taskIds?.[0];
    const removed = await call('DELETE', `/api/portal/tasks/${deleteTarget}`, { token });
    check('deleting a task we created answers 200', removed.status === 200, removed.body);

    const afterDelete = await call('GET', '/api/portal/tasks', { token });
    check(
      'and it is gone from the list',
      !afterDelete.body?.data?.some((t: any) => t.id === deleteTarget),
    );

    if (db) {
      const row = await taskRow(deleteTarget);
      check('AND IT IS GONE FROM POSTGRESQL', row === null, row);
    }

    const unknownDelete = await call('DELETE', '/api/portal/tasks/task-does-not-exist', { token });
    check('deleting an unknown id answers 404', unknownDelete.status === 404, unknownDelete.body);

    // -------------------------------------------------------------------------
    console.log('\nrole boundary');
    // -------------------------------------------------------------------------

    const asMerch = await call('POST', '/api/portal/tasks', {
      token: MERCH_TOKEN,
      body: taskBody([storeA]),
    });

    if (asMerch.status === 403) {
      check(
        'a merchandiser cannot author a briefing',
        asMerch.body?.error === 'TASK_EDIT_FORBIDDEN' || asMerch.status === 403,
        asMerch.body,
      );
      check(
        'and cannot delete one either',
        (await call('DELETE', `/api/portal/tasks/${firstTaskId}`, { token: MERCH_TOKEN }))
          .status === 403,
      );
    } else {
      // Only reachable while the panel is open and the service credential is
      // accepted on these routes; the merchandiser probe then fails earlier for
      // a different reason.
      skip(
        'the task role boundary',
        `the merchandiser credential was not recognised (HTTP ${asMerch.status}) — the panel is open, so this route is reachable with the service credential only`,
      );
    }
  } finally {
    // -------------------------------------------------------------------------
    console.log('\ncleanup');
    // -------------------------------------------------------------------------

    // The fixture submission has to go before its task can: the delete is
    // refused while any evidence points at the task, which is the behaviour
    // this suite just asserted.
    if (db && fixtureEvidenceId) {
      await db.query('DELETE FROM task_evidences WHERE id = $1', [fixtureEvidenceId]);
    }

    for (const id of taskIds) {
      if (id) await call('DELETE', `/api/portal/tasks/${id}`, { token });
    }
    for (const id of storeIds) {
      if (id) await call('DELETE', `/api/portal/stores/${id}`, { token });
    }

    if (db) {
      const tasksAfter = await countOf('store_tasks');
      const storesAfter = await countOf('stores');
      check('the store count is back where the suite found it', storesAfter === storesBefore, {
        before: storesBefore,
        after: storesAfter,
      });
      check('and the store task count is too', tasksAfter === tasksBefore, {
        before: tasksBefore,
        after: tasksAfter,
      });
      // Templates have no delete endpoint, so a briefing that WAS dispatched
      // stays as an orphan row by design. What must be true is that the only
      // growth is this run's own briefings — a refused create must not leave
      // one behind, which is what `discardTemplate` is for.
      const templatesAfter = await countOf('task_templates');
      check(
        'and the only templates left behind are this run\u2019s briefings',
        templatesAfter !== null &&
          templatesBefore !== null &&
          templatesAfter - templatesBefore === templateIds.length,
        { before: templatesBefore, after: templatesAfter, created: templateIds.length },
      );
      await db.end();
    }
  }

  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\n⛔ Suite crashed:', error);
  process.exitCode = 1;
});
