/**
 * oneTeam — roles and people suite
 * ============================================================================
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * Phase 1.5 gave the platform a role model it can enforce and a way to add the
 * people the roles apply to. Both halves are the kind of thing that looks
 * finished while being wrong, because the failure is an *absence*: a missing
 * check produces a 200, and a 200 looks like success.
 *
 * There were two concrete holes and this suite exists to keep them closed:
 *
 *   1. `reviewSubmission` and `autoApproveSubmission` both took a principal and
 *      never read its role. `mayUseRoute` keeps a device credential off those
 *      routes, and `canUserAccessTask` keeps a merchandiser off tasks that are
 *      not theirs — but the enrolment flow *assigns* a store's open work to
 *      whoever enrols with its code, so the author of a submission is the
 *      assignee of its task. The hole was therefore exact rather than general:
 *      the one merchandiser who could reach the route was the one whose photo
 *      was being judged, and they could approve it.
 *
 *   2. Nothing could create a person. `GET /api/panel/keys` already returned a
 *      `users` array to issue keys against, but the only people who existed were
 *      the three in `db/api-seed.sql` — which the migration runner does not even
 *      apply. "Hər adama öz açarı" worked for exactly three people.
 *
 * THE LOAD-BEARING ASSERTIONS
 * ---------------------------
 * Not the status codes. Those are cheap to get right and cheap to fake. The
 * three that matter are:
 *
 *   THE PRECONDITION FOR THE ATTACK IS REAL — the fixture task is assigned to
 *   the field worker who photographed it. Without this the gate is never
 *   reached, and a green run would prove nothing. The first version of this file
 *   missed it and stayed green with the gate deleted.
 *
 *   A REFUSED REVIEW DID NOT MOVE THE TASK. A 403 that still transitioned the
 *   store task would be worse than no check at all — it would report a refusal
 *   and record an approval.
 *
 *   A CREATED PERSON AND THEIR KEY ARE IN POSTGRESQL, READ BACK WITH A
 *   SEPARATE CONNECTION. This is the project's oldest failure: an in-memory
 *   push that never reaches the database looks correct until the next deploy
 *   and then vanishes. A person whose row is missing would be handed a key that
 *   fails its foreign key — and `issuePanelToken` reports that as
 *   `KEY_NOT_STORED`, which the operator cannot tell apart from an outage.
 *
 * THE LAST-ADMINISTRATOR RULE, AND HOW IT IS TESTED
 * ------------------------------------------------
 * `updateUser` and `deleteUser` refuse to remove or demote the only
 * administrator, because key management and user management are both ADMIN-only
 * and a deployment with no admin can never be administered again.
 *
 * While the in-memory array and the database agree, that branch is unreachable
 * from the API: the caller must be an admin, so if the target is a *different*
 * admin there are at least two. The branch fires when the two disagree — memory
 * ahead of the database, which is this project's signature failure. So the test
 * makes them disagree on purpose (create an admin, delete its row behind the
 * API's back) and asserts the refusal. That is the honest way to test it, and
 * it also proves the check reads the database rather than the array it could
 * have read instead.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 * It does not prove a SUPERVISOR cannot review their own submission, and that
 * is deliberate rather than an omission: `ADMIN_ROLES` is a flat set and there
 * is no "not your own work" rule for supervisors, who are assumed to review
 * other people's. A supervisor who photographed a shelf and then approved it
 * would not be stopped. That is a product decision, and it is written here so
 * the next reader does not mistake this suite's green for a guarantee it never
 * made.
 *
 * Prerequisites: the API must be running, and DATABASE_URL must point at the
 * same database it is using.
 *
 *   PORT=3101 DATABASE_URL=postgres://... npm run api:dev
 *   DATABASE_URL=postgres://... ONETEAM_API_URL=http://localhost:3101 \
 *     npm run test:roles
 */

import { Client } from 'pg';
import { FRESH_FIX_AT } from './helpers/fresh-fix';
import { serviceToken } from './helpers/service-token';

const API_BASE = (process.env.ONETEAM_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || '';

/** A panel login key, when the panel is locked. */
const PANEL_KEY = process.env.ONETEAM_TEST_PANEL_KEY || '';
/** The administrator service credential, usable only while the panel has no keys at all. */
const ADMIN_TOKEN = process.env.ONETEAM_TEST_ADMIN_TOKEN || serviceToken('usr-admin-001');

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

/** A store body that should be accepted. */
function storeBody(code: string) {
  return {
    store_code: code,
    name: `Rol Suite Mağazası ${code.slice(-4)}`,
    address: 'Rol suite ünvanı 1, Bakı',
    latitude: 40.3724,
    longitude: 49.8372,
    locatedAt: FRESH_FIX_AT(),
  };
}

/** How many rows a table holds, read with a separate connection. */
async function countRows(db: Client, table: string): Promise<number> {
  const result = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}

/** One user row, or null. Read from the database, never from the API's answer. */
async function userRow(db: Client, userId: string): Promise<any | null> {
  const result = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
  return result.rows[0] ?? null;
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // Which credential are we?
  // ---------------------------------------------------------------------------
  const candidates: Array<{ label: string; token: string }> = [];
  if (PANEL_KEY) candidates.push({ label: 'the panel key', token: PANEL_KEY });
  candidates.push({ label: 'the service credential', token: ADMIN_TOKEN });

  let adminToken = '';
  let chosenLabel = '';
  let lastFailure = '';

  for (const candidate of candidates) {
    const probe = await call('GET', '/api/panel/me', { token: candidate.token }).catch((error) => ({
      status: 0,
      body: { message: String(error) },
    }));
    if (probe.status === 200 && probe.body?.data?.role === 'ADMIN') {
      adminToken = candidate.token;
      chosenLabel = candidate.label;
      break;
    }
    lastFailure = `HTTP ${probe.status}: ${JSON.stringify(probe.body)}`;
  }

  if (!adminToken) {
    console.log('\n\x1b[33mSKIPPED — no administrator credential is accepted.\x1b[0m');
    console.log(`  Tried: ${candidates.map((c) => c.label).join(', ')}`);
    console.log(`  Last answer: ${lastFailure}`);
    console.log('\n  If the panel is locked, mint a key and pass it in:');
    console.log('    ONETEAM_TEST_PANEL_KEY=otp_... npm run test:roles\n');
    process.exit(0);
  }

  console.log(`\n\x1b[1moneTeam — roles and people suite\x1b[0m  (run ${RUN})`);
  console.log(`  Authenticating as ${chosenLabel}.\n`);

  let db: Client | null = null;
  if (DATABASE_URL) {
    db = new Client({ connectionString: DATABASE_URL });
    try {
      await db.connect();
    } catch (error) {
      console.log(
        `\x1b[33m  DATABASE_URL could not be reached (${
          error instanceof Error ? error.message : String(error)
        }).\x1b[0m`,
      );
      console.log('  The PostgreSQL assertions will be skipped, and so will the checks that');
      console.log('  depend on them — a green run without them would prove much less.\n');
      db = null;
    }
  } else {
    console.log('\x1b[33m  DATABASE_URL is not set — skipping the PostgreSQL assertions.\x1b[0m\n');
  }

  /**
   * THE SUITE HAS TO HOLD A KEY FOR EACH ROLE, AND THAT IS NOT A CONVENIENCE
   * ------------------------------------------------------------------------
   * The panel locks the instant the first key exists — that is the activation
   * model this deployment chose ("açar yaradılanda"): once any key is live,
   * `panelAuthStatus().required` is true and `mayUseRoute` refuses the service
   * credential on `/api/portal/*` and `/api/panel/*`.
   *
   * So a suite that starts against an open panel and then mints a key locks
   * itself out of every route it was about to test — which is exactly what
   * happened the first time this file ran. The fix is not to avoid minting but
   * to mint deliberately: take a key for each of the three seeded roles up
   * front, while the admin credential still works, and use those keys as the
   * three principals for the rest of the run.
   *
   * It is also the more faithful test. In production the caller is always a
   * person holding their own key; the service credential is the bootstrap case.
   *
   * Everything minted here is revoked in the cleanup, so a run against an open
   * panel leaves it open and a run against a locked one leaves it locked.
   */
  const mintedPrefixes: string[] = [];
  /** Set when the admin key is ours, so the cleanup knows to sign out with it. */
  let adminKeyIsOurs = false;
  /**
   * The hash prefix of the key this suite is signed in with.
   *
   * Tracked by value rather than assumed to be the last one minted. It is not:
   * the administrator key has to be minted first, because minting it is what
   * locks the panel and every later mint needs a working credential. The first
   * version of this file took `slice(-1)[0]` and therefore tried to revoke the
   * merchandiser's key as if it were its own session — leaving that key live
   * and the panel locked behind it.
   */
  let adminKeyPrefix: string | undefined;

  const mintFor = async (userId: string, label: string): Promise<string> => {
    const minted = await call('POST', '/api/panel/keys', {
      token: adminToken,
      body: { userId, label },
    });
    if (minted.status !== 201) return '';
    mintedPrefixes.push(minted.body?.data?.hashPrefix);
    return minted.body?.data?.token ?? '';
  };

  if (!PANEL_KEY) {
    // The panel is open and the credential in hand is the service one, which
    // stops working the moment this call succeeds. It is therefore the last
    // call made with it.
    adminToken = await mintFor(
      (await call('GET', '/api/panel/me', { token: adminToken })).body?.data?.userId,
      `roles suite — administrator (${RUN})`,
    );
    adminKeyIsOurs = adminToken !== '';
    adminKeyPrefix = adminKeyIsOurs ? mintedPrefixes[mintedPrefixes.length - 1] : undefined;
    if (!adminKeyIsOurs) {
      console.log(
        '\x1b[33m  Could not mint an administrator key — the suite cannot continue.\x1b[0m\n',
      );
      process.exit(0);
    }
  }

  const superToken = await mintFor('usr-super-002', `roles suite — supervisor (${RUN})`);
  const merchToken = await mintFor('usr-merch-003', `roles suite — merchandiser (${RUN})`);

  if (!superToken || !merchToken) {
    console.log(
      '\x1b[33m  Could not mint a key for the seeded supervisor and merchandiser.\x1b[0m',
    );
    console.log('  The role-boundary checks need both. If the panel is locked, sign in as an');
    console.log('  administrator and make sure those two people still exist.\n');
  } else {
    console.log('  Minted a key for each of the three seeded roles.\n');
  }

  /** Fixtures to clean up, in reverse order of creation. */
  let storeId: string | undefined;
  let storeTaskId: string | undefined;
  let evidenceId: string | undefined;
  let deviceToken: string | undefined;
  let fieldUserId: string | undefined;
  let createdUserId: string | undefined;
  let createdUserToken: string | undefined;
  let promotedUserId: string | undefined;
  let baseline: {
    users: number;
    stores: number;
    tasks: number;
    evidences: number;
  } | null = null;

  try {
    // -------------------------------------------------------------------------
    console.log('1. Who each credential is');
    // -------------------------------------------------------------------------
    const meAdmin = await call('GET', '/api/panel/me', { token: adminToken });
    check(
      'the administrator credential resolves to an ADMIN',
      meAdmin.body?.data?.role === 'ADMIN',
      meAdmin.body,
    );

    const meSuper = await call('GET', '/api/panel/me', { token: superToken });
    check(
      'the supervisor credential resolves to a SUPERVISOR',
      meSuper.body?.data?.role === 'SUPERVISOR',
      meSuper.body,
    );
    check(
      'and a supervisor is not offered key management',
      meSuper.body?.data?.canManageKeys === false,
      meSuper.body?.data,
    );

    const meMerch = await call('GET', '/api/panel/me', { token: merchToken });
    check(
      'the merchandiser credential resolves to a MERCHANDISER',
      meMerch.body?.data?.role === 'MERCHANDISER',
      meMerch.body,
    );
    check(
      'and a merchandiser is not offered key management',
      meMerch.body?.data?.canManageKeys === false,
      meMerch.body?.data,
    );

    // -------------------------------------------------------------------------
    console.log('\n2. A submitted audit to judge');
    // -------------------------------------------------------------------------
    baseline = db
      ? {
          users: await countRows(db, 'users'),
          stores: await countRows(db, 'stores'),
          tasks: await countRows(db, 'store_tasks'),
          evidences: await countRows(db, 'task_evidences'),
        }
      : null;
    if (baseline) {
      console.log(
        `  baseline: ${baseline.users} users, ${baseline.stores} stores, ` +
          `${baseline.tasks} tasks, ${baseline.evidences} submissions`,
      );
    }

    const storeCode = `ROLE_${RUN}`;
    const created = await call('POST', '/api/portal/stores', {
      token: adminToken,
      body: storeBody(storeCode),
    });
    check('a fixture store is created', created.status === 201, created.body);
    storeId = created.body?.data?.id;

    const dispatched = await call('POST', '/api/portal/tasks', {
      token: adminToken,
      body: {
        title: `Rol suite ${RUN}`,
        description: 'Suite tərəfindən yaradılmış müvəqqəti tapşırıq.',
        priority: 'MEDIUM',
        deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        assigned_stores: [storeId],
      },
    });
    check('and one briefing is dispatched to it', dispatched.status === 201, dispatched.body);
    storeTaskId = dispatched.body?.data?.taskIds?.[0];
    check('which produced exactly one store task', Boolean(storeTaskId), dispatched.body?.data);

    // A field worker enrols, acknowledges and submits — the real path, so the
    // task reaches SUBMITTED the way it does in production rather than by being
    // written into that state from a test.
    const deviceId = `role-suite-device-${RUN}`;
    const enrolled = await call('POST', '/api/portal/field/enroll', {
      body: { storeCode, fullName: `Sahə işçisi ${RUN}`, deviceId },
    });
    check(
      'a field worker can enrol against the fixture store',
      enrolled.status === 200,
      enrolled.body,
    );
    deviceToken = enrolled.body?.data?.token;
    fieldUserId = enrolled.body?.data?.userId;
    check(
      'and the enrolment returns a device credential',
      Boolean(deviceToken),
      enrolled.body?.data,
    );
    check(
      'and the field worker is a MERCHANDISER',
      enrolled.body?.data?.role === 'MERCHANDISER',
      enrolled.body?.data?.role,
    );

    const acknowledged = await call('POST', `/api/portal/field/tasks/${storeTaskId}/acknowledge`, {
      token: deviceToken,
      body: { deviceId },
    });
    check(
      'the task is acknowledged',
      acknowledged.body?.data?.currentState === 'ACKNOWLEDGED',
      acknowledged.body,
    );

    const submitted = await call('POST', '/api/portal/field/submissions', {
      token: deviceToken,
      body: {
        deviceId,
        storeTaskId,
        photoUrl: 'data:image/png;base64,iVBORw0KGgo=',
        photoType: 'standard',
        latitude: 40.3724,
        longitude: 49.8372,
        locatedAt: FRESH_FIX_AT(),
      },
    });
    check('and a photo is submitted', submitted.status === 201, submitted.body);
    evidenceId = submitted.body?.data?.id;
    check('which produces an audit record', Boolean(evidenceId), submitted.body?.data);

    /** The panel's view of the fixture task, used to prove nothing moved. */
    const fixtureTaskStatus = async (): Promise<string | undefined> => {
      const tasks = await call('GET', '/api/portal/tasks', { token: adminToken });
      return (tasks.body?.data ?? []).find((task: any) => task.id === storeTaskId)?.status;
    };
    const statusBefore = await fixtureTaskStatus();
    check('the fixture task reads as awaiting review', statusBefore === 'published', statusBefore);

    // -------------------------------------------------------------------------
    console.log('\n3. The review gate — a field worker may not judge their own work');
    // -------------------------------------------------------------------------
    /**
     * WHO THE ATTACKER ACTUALLY IS
     * ----------------------------
     * Not "any merchandiser". `transitionTask` already refuses a caller for a
     * task they cannot reach, and `canUserAccessTask` lets a MERCHANDISER reach
     * exactly one kind of task: the one assigned to them.
     *
     * And the enrolment flow assigns it to them. `FieldService.bind` calls
     * `claimStoreTasks`, which hands a store's open work to whoever enrolled
     * with its code — so the person who photographed the shelf is, by
     * construction, the assignee of the task the photo belongs to.
     *
     * That makes the hole exact rather than general: **the one caller who could
     * reach this route as a merchandiser was the author of the submission being
     * judged.** A merchandiser with a panel key could approve their own shelf
     * photo, which is the fraud the platform exists to prevent.
     *
     * The first version of this file tested it with the seeded merchandiser
     * (`usr-merch-003`), who is not the assignee — so it passed for the wrong
     * reason and would have stayed green with the gate removed. The break pass
     * caught it. This version signs in as the assignee.
     */
    if (db && fieldUserId && storeTaskId) {
      const assigned = await db.query('SELECT assigned_user_id FROM store_tasks WHERE id = $1', [
        storeTaskId,
      ]);
      check(
        'THE PRECONDITION: the fixture task is assigned to the field worker who photographed it',
        assigned.rows[0]?.assigned_user_id === fieldUserId,
        { assigned: assigned.rows[0]?.assigned_user_id, fieldUserId },
      );
    } else {
      skip(
        'THE PRECONDITION: the fixture task is assigned to the field worker who photographed it',
        db ? 'no fixture ids' : 'DATABASE_URL is not set',
      );
    }

    // A panel key for the field worker. This is the credential the attack needs,
    // and an administrator can legitimately issue it — a merchandiser who also
    // does panel work is a normal thing to have.
    const selfToken = await mintFor(fieldUserId ?? '', `roles suite — the author (${RUN})`);

    const selfMe = await call('GET', '/api/panel/me', { token: selfToken });
    check(
      'the author holds a panel key that resolves to them',
      selfMe.status === 200 && selfMe.body?.data?.userId === fieldUserId,
      { status: selfMe.status, body: selfMe.body?.data },
    );
    check(
      'and that credential is a MERCHANDISER, not a reviewer',
      selfMe.body?.data?.role === 'MERCHANDISER',
      selfMe.body?.data?.role,
    );

    const selfReview = await call('POST', `/api/portal/submissions/${evidenceId}/review`, {
      token: selfToken,
      body: { status: 'approved', feedback: 'Öz işimi özüm təsdiqləyirəm' },
    });
    check('AND THE AUTHOR MAY NOT APPROVE THEIR OWN SUBMISSION (403)', selfReview.status === 403, {
      status: selfReview.status,
      body: selfReview.body,
    });
    check(
      'and the refusal names REVIEW_FORBIDDEN rather than the task-access rule',
      selfReview.body?.error === 'REVIEW_FORBIDDEN',
      selfReview.body,
    );

    const selfAuto = await call('POST', `/api/portal/submissions/${evidenceId}/auto-approve`, {
      token: selfToken,
    });
    check('AND MAY NOT AUTO-APPROVE IT EITHER (403)', selfAuto.status === 403, {
      status: selfAuto.status,
      body: selfAuto.body,
    });
    check(
      'and that refusal names REVIEW_FORBIDDEN too',
      selfAuto.body?.error === 'REVIEW_FORBIDDEN',
      selfAuto.body,
    );

    // The one that matters: a refusal that still moved the state would report a
    // rejection and record an approval.
    const statusAfter = await fixtureTaskStatus();
    check('AND A REFUSED REVIEW DID NOT MOVE THE TASK', statusAfter === statusBefore, {
      before: statusBefore,
      after: statusAfter,
    });

    const submissions = await call('GET', '/api/portal/submissions', { token: adminToken });
    const fixtureSubmission = (submissions.body?.data ?? []).find(
      (row: any) => row.id === evidenceId,
    );
    check(
      'and the submission still reads as pending review',
      fixtureSubmission?.status === 'pending_review',
      fixtureSubmission?.status,
    );

    // A merchandiser who is NOT the assignee is also refused. This check is
    // labelled as what it is: the review gate answers first, so it does not
    // isolate the earlier task-access layer — it only confirms that a second
    // merchandiser is refused too, whatever the reason. Asserting a specific
    // code here would have pinned the order of two independent guards, which is
    // not a property worth freezing.
    const otherMerch = await call('POST', `/api/portal/submissions/${evidenceId}/review`, {
      token: merchToken,
      body: { status: 'approved', feedback: 'başqasının işi' },
    });
    check('an unrelated merchandiser is refused as well', otherMerch.status === 403, {
      status: otherMerch.status,
      body: otherMerch.body,
    });

    // A supervisor is allowed — the refusals above must be about the role, not
    // about the route being broken for everybody.
    const superReview = await call('POST', `/api/portal/submissions/${evidenceId}/review`, {
      token: superToken,
      body: { status: 'approved', feedback: 'Suite: supervayzer təsdiqlədi' },
    });
    check('reviewing the same submission as a SUPERVISOR succeeds', superReview.status === 200, {
      status: superReview.status,
      body: superReview.body,
    });
    check(
      'and the task reaches APPROVED',
      superReview.body?.data?.currentState === 'APPROVED',
      superReview.body?.data,
    );

    // -------------------------------------------------------------------------
    console.log('\n4. Who may manage people — administrators only');
    // -------------------------------------------------------------------------
    const superList = await call('GET', '/api/panel/users', { token: superToken });
    check(
      'a SUPERVISOR may not list users (403 ADMIN_REQUIRED)',
      superList.status === 403 && superList.body?.error === 'ADMIN_REQUIRED',
      { status: superList.status, body: superList.body },
    );
    const superCreate = await call('POST', '/api/panel/users', {
      token: superToken,
      body: { fullName: 'İcazəsiz', role: 'ADMIN' },
    });
    check(
      'a SUPERVISOR may not create a user',
      superCreate.status === 403 && superCreate.body?.error === 'ADMIN_REQUIRED',
      { status: superCreate.status, body: superCreate.body },
    );
    const superPatch = await call('PATCH', `/api/panel/users/${fieldUserId}`, {
      token: superToken,
      body: { role: 'ADMIN' },
    });
    check(
      'a SUPERVISOR may not promote themselves',
      superPatch.status === 403 && superPatch.body?.error === 'ADMIN_REQUIRED',
      { status: superPatch.status, body: superPatch.body },
    );
    const superDelete = await call('DELETE', `/api/panel/users/${fieldUserId}`, {
      token: superToken,
    });
    check(
      'a SUPERVISOR may not delete a user',
      superDelete.status === 403 && superDelete.body?.error === 'ADMIN_REQUIRED',
      { status: superDelete.status, body: superDelete.body },
    );

    const merchList = await call('GET', '/api/panel/users', { token: merchToken });
    check('and a MERCHANDISER may not list users either', merchList.status === 403, {
      status: merchList.status,
      body: merchList.body,
    });

    // -------------------------------------------------------------------------
    console.log('\n5. Creating a person');
    // -------------------------------------------------------------------------
    const listed = await call('GET', '/api/panel/users', { token: adminToken });
    check('an ADMIN can list users', listed.status === 200, listed.body);
    check(
      'and the list carries the roles a form needs to offer',
      Array.isArray(listed.body?.data?.roles) && listed.body.data.roles.includes('SUPERVISOR'),
      listed.body?.data?.roles,
    );
    check(
      'and it says how many administrators there are',
      typeof listed.body?.data?.adminCount === 'number',
      listed.body?.data?.adminCount,
    );

    const newName = `Suite Supervayzer ${RUN}`;
    const newEmail = `suite-${RUN.toLowerCase()}@coke.oneteam.az`;
    const madeUser = await call('POST', '/api/panel/users', {
      token: adminToken,
      body: { fullName: newName, email: newEmail, role: 'SUPERVISOR', phone: '+994500000000' },
    });
    check('a new SUPERVISOR can be created', madeUser.status === 201, madeUser.body);
    createdUserId = madeUser.body?.data?.id;
    check('and it comes back with an id', Boolean(createdUserId), madeUser.body?.data);

    if (db && createdUserId) {
      const row = await userRow(db, createdUserId);
      check('AND THE ROW IS IN POSTGRESQL', row !== null, row);
      check('with the name that was typed', row?.full_name === newName, row?.full_name);
      check('and the role that was chosen', row?.role === 'SUPERVISOR', row?.role);
      check('and the email', row?.email === newEmail, row?.email);
    } else {
      skip('AND THE ROW IS IN POSTGRESQL', db ? 'no id came back' : 'DATABASE_URL is not set');
    }

    // A duplicate email is a refusal the operator can act on, not a merge onto
    // somebody else's row.
    const duplicate = await call('POST', '/api/panel/users', {
      token: adminToken,
      body: { fullName: 'Başqa adam', email: newEmail, role: 'MERCHANDISER' },
    });
    check(
      'a second person with the same email is refused with 409',
      duplicate.status === 409 && duplicate.body?.error === 'EMAIL_TAKEN',
      { status: duplicate.status, body: duplicate.body },
    );

    const badRole = await call('POST', '/api/panel/users', {
      token: adminToken,
      body: { fullName: 'Rolsuz adam', role: 'SUPERADMIN' },
    });
    check(
      'an invented role is refused with 400',
      badRole.status === 400 && badRole.body?.error === 'INVALID_ROLE',
      { status: badRole.status, body: badRole.body },
    );

    const noName = await call('POST', '/api/panel/users', {
      token: adminToken,
      body: { fullName: '   ', role: 'MERCHANDISER' },
    });
    check(
      'a blank name is refused with 400',
      noName.status === 400 && noName.body?.error === 'FULL_NAME_REQUIRED',
      { status: noName.status, body: noName.body },
    );

    // A person with no email at all is allowed. The column is NOT NULL, so the
    // database layer synthesises `<id>@oneteam.local` — and the list reports it
    // as absent rather than showing a placeholder nobody can receive mail at.
    const noEmail = await call('POST', '/api/panel/users', {
      token: adminToken,
      body: { fullName: `Poçtsuz ${RUN}`, role: 'MERCHANDISER' },
    });
    check('a person with no email can still be created', noEmail.status === 201, noEmail.body);
    const noEmailId = noEmail.body?.data?.id;
    check(
      'and the address is reported as absent rather than invented',
      noEmail.body?.data?.email === null,
      noEmail.body?.data?.email,
    );
    if (db && noEmailId) {
      const row = await userRow(db, noEmailId);
      check(
        'and the synthesised address is clearly marked as local',
        typeof row?.email === 'string' && row.email.endsWith('@oneteam.local'),
        row?.email,
      );
      // Cleaned up here rather than at the end: it has no keys and no
      // submissions, so the delete is a one-liner and it keeps the later
      // counts honest.
      await db.query('DELETE FROM users WHERE id = $1', [noEmailId]);
    }

    // -------------------------------------------------------------------------
    console.log('\n6. Changing a role');
    // -------------------------------------------------------------------------
    const promoted = await call('PATCH', `/api/panel/users/${createdUserId}`, {
      token: adminToken,
      body: { role: 'MERCHANDISER' },
    });
    check('a role can be changed', promoted.status === 200, promoted.body);
    check(
      'and the answer carries the new role',
      promoted.body?.data?.role === 'MERCHANDISER',
      promoted.body?.data,
    );

    if (db && createdUserId) {
      const row = await userRow(db, createdUserId);
      check('AND THE NEW ROLE IS IN POSTGRESQL', row?.role === 'MERCHANDISER', row?.role);
    } else {
      skip('AND THE NEW ROLE IS IN POSTGRESQL', 'DATABASE_URL is not set');
    }

    const backToSupervisor = await call('PATCH', `/api/panel/users/${createdUserId}`, {
      token: adminToken,
      body: { role: 'SUPERVISOR' },
    });
    check(
      'and changed back',
      backToSupervisor.body?.data?.role === 'SUPERVISOR',
      backToSupervisor.body?.data,
    );

    const emptyEdit = await call('PATCH', `/api/panel/users/${createdUserId}`, {
      token: adminToken,
      body: {},
    });
    check(
      'an edit with nothing in it is refused rather than reported as saved',
      emptyEdit.status === 400 && emptyEdit.body?.error === 'NOTHING_TO_CHANGE',
      { status: emptyEdit.status, body: emptyEdit.body },
    );

    // Changing your own role is refused, and the reason is the session doing the
    // changing: an admin who demotes themselves keeps a working key and loses
    // every screen that key was for.
    const ownUserId = meAdmin.body?.data?.userId;
    const selfDemote = await call('PATCH', `/api/panel/users/${ownUserId}`, {
      token: adminToken,
      body: { role: 'SUPERVISOR' },
    });
    check(
      'changing your own role is refused with 400',
      selfDemote.status === 400 && selfDemote.body?.error === 'CANNOT_CHANGE_OWN_ROLE',
      { status: selfDemote.status, body: selfDemote.body },
    );

    // -------------------------------------------------------------------------
    console.log('\n7. A key for the new person — the point of the whole phase');
    // -------------------------------------------------------------------------
    const minted = await call('POST', '/api/panel/keys', {
      token: adminToken,
      body: { userId: createdUserId, label: `Suite ${RUN}` },
    });
    check('a key can be minted for the new person', minted.status === 201, minted.body);
    createdUserToken = minted.body?.data?.token;
    check(
      'and it is returned once, as a key',
      typeof createdUserToken === 'string' && createdUserToken.startsWith('otp_'),
      createdUserToken ? `${String(createdUserToken).slice(0, 7)}…` : createdUserToken,
    );

    if (db && createdUserId) {
      const keyRow = await db.query(
        'SELECT user_id, revoked_at FROM panel_tokens WHERE user_id = $1',
        [createdUserId],
      );
      check(
        'AND THE KEY ROW IS IN POSTGRESQL, FOR THAT PERSON',
        keyRow.rows.length === 1,
        keyRow.rows,
      );
      check(
        'and it is stored only as a hash, never as the key itself',
        keyRow.rows[0]
          ? !JSON.stringify(keyRow.rows[0]).includes(createdUserToken ?? '\u0000')
          : false,
      );
    } else {
      skip('AND THE KEY ROW IS IN POSTGRESQL, FOR THAT PERSON', 'DATABASE_URL is not set');
    }

    const newMe = await call('GET', '/api/panel/me', { token: createdUserToken });
    check(
      'THE NEW KEY SIGNS IN AS THE NEW PERSON',
      newMe.status === 200 && newMe.body?.data?.userId === createdUserId,
      { status: newMe.status, body: newMe.body?.data },
    );
    check(
      'with the role they were given',
      newMe.body?.data?.role === 'SUPERVISOR',
      newMe.body?.data?.role,
    );
    check(
      'and they are not offered key management',
      newMe.body?.data?.canManageKeys === false,
      newMe.body?.data,
    );

    // A supervisor may author work — the boundary that makes the role worth
    // having — and may not manage people. Both are asserted so that a future
    // tightening cannot quietly take away the first while fixing the second.
    const supervisorTask = await call('POST', '/api/portal/tasks', {
      token: createdUserToken,
      body: {
        title: `Supervayzer tərəfindən ${RUN}`,
        description: 'Suite: yeni supervayzerin yarada bildiyini yoxlayır.',
        priority: 'LOW',
        deadline: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        assigned_stores: [storeId],
      },
    });
    check('A NEW SUPERVISOR CAN AUTHOR WORK', supervisorTask.status === 201, {
      status: supervisorTask.status,
      body: supervisorTask.body,
    });
    const extraTaskId = supervisorTask.body?.data?.taskIds?.[0];

    const supervisorUsers = await call('GET', '/api/panel/users', { token: createdUserToken });
    check('but still may not manage people', supervisorUsers.status === 403, {
      status: supervisorUsers.status,
      body: supervisorUsers.body,
    });

    // The extra task has no submission, so it can be removed without touching
    // the audit trail. Done here so the final count matches the baseline.
    if (extraTaskId) {
      await call('DELETE', `/api/portal/tasks/${extraTaskId}`, { token: adminToken });
    }

    // -------------------------------------------------------------------------
    console.log('\n8. The last administrator may not be removed');
    // -------------------------------------------------------------------------
    // Built deliberately: the in-memory array and the database are made to
    // disagree, because while they agree this branch is unreachable — the caller
    // must be an admin, so a *different* admin target implies at least two.
    const secondAdmin = await call('POST', '/api/panel/users', {
      token: adminToken,
      body: { fullName: `İkinci admin ${RUN}`, role: 'ADMIN' },
    });
    check('a second administrator can be created', secondAdmin.status === 201, secondAdmin.body);
    promotedUserId = secondAdmin.body?.data?.id;

    if (db && promotedUserId) {
      // Removed behind the API's back. The process still holds it in memory, so
      // the API believes there are two administrators while the database knows
      // there is one — which is the only state in which the rule can fire.
      await db.query('DELETE FROM users WHERE id = $1', [promotedUserId]);
      const stillInMemory = await call('GET', '/api/panel/users', { token: adminToken });
      const seenByApi = (stillInMemory.body?.data?.users ?? []).find(
        (user: any) => user.id === promotedUserId,
      );
      check(
        'the process still believes the second administrator exists (memory ahead of the database)',
        Boolean(seenByApi),
        seenByApi?.id,
      );

      const demoteLast = await call('PATCH', `/api/panel/users/${promotedUserId}`, {
        token: adminToken,
        body: { role: 'MERCHANDISER' },
      });
      check(
        'AND THE DEMOTION IS REFUSED WITH 409 LAST_ADMIN',
        demoteLast.status === 409 && demoteLast.body?.error === 'LAST_ADMIN',
        { status: demoteLast.status, body: demoteLast.body },
      );
      check(
        'which proves the rule reads the database, not the array it could have read',
        demoteLast.status === 409,
        'memory said two administrators; the database said one; the answer followed the database',
      );
    } else {
      skip(
        'AND THE DEMOTION IS REFUSED WITH 409 LAST_ADMIN',
        db ? 'no id came back' : 'DATABASE_URL is not set',
      );
    }

    // -------------------------------------------------------------------------
    console.log('\n9. Removing a person');
    // -------------------------------------------------------------------------
    const selfDelete = await call('DELETE', `/api/panel/users/${ownUserId}`, { token: adminToken });
    check(
      'deleting your own account is refused with 400',
      selfDelete.status === 400 && selfDelete.body?.error === 'CANNOT_DELETE_SELF',
      { status: selfDelete.status, body: selfDelete.body },
    );

    // The field worker has one submission, and `task_evidences.submitted_by_id`
    // is ON DELETE RESTRICT — so they are part of the audit trail.
    const deleteSubmitter = await call('DELETE', `/api/panel/users/${fieldUserId}`, {
      token: adminToken,
    });
    check(
      'deleting somebody who has submitted an audit is refused with 409',
      deleteSubmitter.status === 409 && deleteSubmitter.body?.error === 'USER_HAS_SUBMISSIONS',
      { status: deleteSubmitter.status, body: deleteSubmitter.body },
    );
    check(
      'and it says how many submissions are in the way',
      deleteSubmitter.body?.submissions === 1,
      deleteSubmitter.body?.submissions,
    );
    if (db && fieldUserId) {
      const stillThere = await userRow(db, fieldUserId);
      check('AND THE PERSON IS STILL IN POSTGRESQL', stillThere !== null, stillThere);
    }

    // A person who has authored nothing can go.
    const deleteClean = await call('DELETE', `/api/panel/users/${createdUserId}`, {
      token: adminToken,
    });
    check(
      'a person with no submissions can be deleted',
      deleteClean.status === 200,
      deleteClean.body,
    );
    if (db && createdUserId) {
      const gone = await userRow(db, createdUserId);
      check('AND THE ROW IS GONE FROM POSTGRESQL', gone === null, gone);
      const keysGone = await db.query(
        'SELECT count(*)::int AS n FROM panel_tokens WHERE user_id = $1',
        [createdUserId],
      );
      check(
        'and their keys went with them (the schema cascades)',
        keysGone.rows[0]?.n === 0,
        keysGone.rows[0]?.n,
      );
    } else {
      skip('AND THE ROW IS GONE FROM POSTGRESQL', 'DATABASE_URL is not set');
    }

    const revokedKeyWorks = await call('GET', '/api/panel/me', { token: createdUserToken });
    check('and the deleted person\u2019s key no longer works', revokedKeyWorks.status === 401, {
      status: revokedKeyWorks.status,
      body: revokedKeyWorks.body,
    });
    createdUserToken = undefined;

    // The field worker can go once the submission that protected them is gone.
    // This is what makes the 409 above meaningful rather than a route that
    // refuses everything.
    if (db && evidenceId) {
      await db.query('DELETE FROM task_evidences WHERE id = $1', [evidenceId]);
      const deleteNow = await call('DELETE', `/api/panel/users/${fieldUserId}`, {
        token: adminToken,
      });
      check('with the submission gone, the same person can be deleted', deleteNow.status === 200, {
        status: deleteNow.status,
        body: deleteNow.body,
      });
      evidenceId = undefined;
    } else {
      skip('with the submission gone, the same person can be deleted', 'DATABASE_URL is not set');
    }
  } finally {
    // -------------------------------------------------------------------------
    console.log('\n10. Cleaning up');
    // -------------------------------------------------------------------------
    // Reverse order, because each row is what the previous one points at. The
    // submission normally went in section 9; when there is no database to
    // remove it with, the task delete is refused with 409 — which is the
    // product behaving correctly, not a cleanup failure, so it is said rather
    // than warned about.
    //
    // `taskGone` is tracked rather than inferred from `storeTaskId` being
    // cleared: the first version only cleared the id inside the 409 branch, so
    // a *successful* task delete left the id set and the store delete was
    // skipped — leaving one store behind on an otherwise clean run.
    let taskGone = !storeTaskId;
    if (storeTaskId) {
      const removed = await call('DELETE', `/api/portal/tasks/${storeTaskId}`, {
        token: adminToken,
      });
      if (removed.status === 200 || removed.status === 404) {
        taskGone = true;
      } else if (removed.status === 409 && evidenceId) {
        console.log(
          '  the fixture task is kept: its submission can only be removed with a direct ' +
            'database connection, and DATABASE_URL is not set',
        );
      } else {
        console.log(`  \u26A0 could not delete the fixture task: ${JSON.stringify(removed.body)}`);
      }
    }
    if (storeId && taskGone) {
      const removed = await call('DELETE', `/api/portal/stores/${storeId}`, { token: adminToken });
      if (removed.status !== 200 && removed.status !== 404) {
        console.log(`  \u26A0 could not delete the fixture store: ${JSON.stringify(removed.body)}`);
      }
    } else if (storeId) {
      console.log('  the fixture store is kept: its task is still there');
    }
    if (fieldUserId) {
      await call('DELETE', `/api/panel/users/${fieldUserId}`, { token: adminToken });
    }
    if (promotedUserId) {
      await call('DELETE', `/api/panel/users/${promotedUserId}`, { token: adminToken });
    }
    if (createdUserId) {
      await call('DELETE', `/api/panel/users/${createdUserId}`, { token: adminToken });
    }

    // -------------------------------------------------------------------------
    // The keys this suite minted, in reverse. This is not tidiness: the panel
    // locks the moment a key exists, so leaving them behind would leave a
    // deployment that was open now demanding a login — and the operator would
    // have no key, because the keys belong to the seeded users.
    //
    // The suite's own key goes last, through the sign-out route. Revoking it
    // through the key list is refused (`CANNOT_REVOKE_OWN_SESSION`), which is
    // the correct behaviour and the reason this is two different calls.
    // -------------------------------------------------------------------------
    const others = mintedPrefixes.filter((prefix) => prefix !== adminKeyPrefix);
    let revoked = 0;
    let alreadyGone = 0;
    for (const prefix of others) {
      const result = await call('POST', `/api/panel/keys/${prefix}/revoke`, { token: adminToken });
      if (result.status === 200) revoked += 1;
      // 404 is not a failure here. A key belonging to somebody this suite
      // deleted went with them — `panel_tokens.user_id` cascades — so "already
      // gone" is the same outcome reached by a different route.
      else if (result.status === 404) alreadyGone += 1;
    }
    if (others.length > 0) {
      console.log(
        `  ${revoked} of ${others.length} minted key(s) revoked` +
          (alreadyGone ? `, ${alreadyGone} already gone with their owner` : ''),
      );
    }

    if (adminKeyIsOurs) {
      // Signing out revokes the presented key. Done last because it is the
      // credential every call above used.
      const signedOut = await call('POST', '/api/panel/logout', { token: adminToken });
      check(
        'the suite signed out with the key it minted',
        signedOut.status === 200,
        signedOut.body,
      );
      const reopened = await call('GET', '/api/panel/auth-status');
      check(
        'and the panel is back to the state it was found in',
        reopened.body?.data?.liveKeys === 0 && reopened.body?.data?.required === false,
        reopened.body?.data,
      );
    }

    if (db) {
      const after = {
        users: await countRows(db, 'users'),
        stores: await countRows(db, 'stores'),
        tasks: await countRows(db, 'store_tasks'),
        evidences: await countRows(db, 'task_evidences'),
      };
      console.log(
        `  after:    ${after.users} users, ${after.stores} stores, ` +
          `${after.tasks} tasks, ${after.evidences} submissions`,
      );
      const restored =
        after.users === (baseline?.users ?? after.users) &&
        after.stores === (baseline?.stores ?? after.stores) &&
        after.tasks === (baseline?.tasks ?? after.tasks) &&
        after.evidences === (baseline?.evidences ?? after.evidences);
      check('AND THE DATABASE IS BACK WHERE IT STARTED', restored, { baseline, after });
      await db.end();
    }
  }

  console.log(
    `\n\x1b[1m${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\x1b[0m\n`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\n\x1b[31mThe suite itself threw:\x1b[0m', error);
  process.exit(2);
});
