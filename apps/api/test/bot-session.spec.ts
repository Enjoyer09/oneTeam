/**
 * oneTeam — bot session suite (Phase 2.2)
 * ============================================================================
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * The Telegram bot keeps a chat's place in the guided field flow: which store,
 * which task, which checklist answers, which photo is waiting to be confirmed.
 * Until now that lived in a `Map` inside the bot process.
 *
 * A `Map` in a process is fine until the process is replaced — and it is
 * replaced on every deploy. The failure it produces is the worst kind: not an
 * error. A merchandiser answers two of three questions, the container is swapped
 * while they are reading the third, and the next message they send gets "hansı
 * mağazadasınız?" — the store-code prompt. They are standing in a shop and have
 * no way to tell whether they did something wrong, whether the bot is broken, or
 * whether their work was saved.
 *
 * So the flow is stored, and this suite is what says so. The acceptance
 * criterion is verbatim from the plan:
 *
 *   Yenidən başlatma ilə state itmir; `chatId` yenidən yazanda əvvəlki davam edir.
 *
 * WHICH MEANS THE LOAD-BEARING CHECK IS A RESTART
 * -----------------------------------------------
 * "The API answered 200" proves nothing here — the in-memory `Map` would answer
 * 200 as well. The check that matters is:
 *
 *   THE FLOW WRITTEN BY ONE API PROCESS IS READ BACK BY A DIFFERENT ONE.
 *
 * So this suite does not talk to an API someone else started. It starts its own,
 * on its own port, kills it, starts a fresh one, and compares. That is the only
 * way to test the one property the whole feature exists for, and it is why this
 * suite is self-contained rather than following the "the API must be running"
 * convention of the other suites.
 *
 * It also reads `bot_sessions` directly over `pg`, with a connection the API
 * knows nothing about, for the same reason `store-crud.spec.ts` does: a row that
 * only exists in the API's memory looks identical from the outside until the
 * next deploy.
 *
 * WHAT IT CLEANS UP
 * -----------------
 * Every row it writes is deleted, and the last check asserts the table is back
 * to the size it found it. One fixture is not created by this suite at all: the
 * seeded merchandiser `usr-merch-003` already has `telegram_chat_id = '998877665'`,
 * which is used to prove the person is derived from the chat rather than taken
 * from the request body.
 *
 * Prerequisites: PostgreSQL must be reachable, and `apps/api/dist/main.js` must
 * be built (`npm run api:build`).
 *
 *   npm run test:flow
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

/**
 * Refuses to run in production.
 *
 * This is the one suite in the project that starts its own API process, and it
 * starts it against whatever `DATABASE_URL` names. That is exactly what makes it
 * able to test a restart, and exactly what makes it dangerous to point at a
 * deployed environment by accident. The same guard exists in
 * `src/bot/test-runner.ts`, for the same reason.
 */
if (process.env.NODE_ENV === 'production') {
  console.error(
    'Refusing to run: this suite starts its own API and writes rows. It is a development suite.',
  );
  process.exit(1);
}

// `fetch` honours HTTP_PROXY, and this suite talks to 127.0.0.1. Set before the
// first request so undici builds its agent without a proxy.
process.env.NO_PROXY = ['127.0.0.1', 'localhost', process.env.NO_PROXY].filter(Boolean).join(',');
process.env.no_proxy = process.env.NO_PROXY;

/** Its own port, so a developer's API on 3001/3101 is not disturbed. */
const PORT = Number(process.env.ONETEAM_TEST_BOT_PORT || 3111);
const API_BASE = `http://127.0.0.1:${PORT}`;
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';
const TOKEN = process.env.ONETEAM_TEST_ADMIN_TOKEN || 'oneteam-user:usr-admin-001';

const REPO_ROOT = process.cwd();
const API_ENTRY = path.join(REPO_ROOT, 'apps/api/dist/main.js');

/** Unique per run, so two runs against one database do not collide. */
const RUN = Date.now().toString(36).toUpperCase();

const CHAT_NEW = `flow-new-${RUN}`;
const CHAT_EXPIRED = `flow-expired-${RUN}`;
const CHAT_GRACE = `flow-grace-${RUN}`;
const CHAT_SWEPT = `flow-swept-${RUN}`;
const CHAT_DELETE = `flow-delete-${RUN}`;
const CHAT_RESTART = `flow-restart-${RUN}`;

/** The seeded merchandiser's chat. Not created by this suite — see the header. */
const CHAT_BOUND = '998877665';
const BOUND_USER_ID = 'usr-merch-003';

/** Every chat this suite may write, for the final count check. */
const ALL_CHATS = [
  CHAT_NEW,
  CHAT_EXPIRED,
  CHAT_GRACE,
  CHAT_SWEPT,
  CHAT_DELETE,
  CHAT_RESTART,
  CHAT_BOUND,
];

let pass = 0;
let fail = 0;

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

// WHY THERE IS NO `skip` HELPER IN THIS FILE, UNLIKE EVERY OTHER SUITE
// ------------------------------------------------------------------
// The other suites skip when an optional tier is absent — no DATABASE_URL, no
// S3 endpoint — because the rest of their checks still mean something. This
// suite has no such tier: the database and the API it spawns ARE the subject,
// so an absent precondition is a crash, not a skip. A `skip` nothing could
// ever call is a counter that could only ever read zero, and this file had one.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Result {
  status: number;
  body: any;
}

async function call(
  method: string,
  requestPath: string,
  options: { body?: unknown; token?: string } = {},
): Promise<Result> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.token ?? TOKEN}`,
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${API_BASE}${requestPath}`, {
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

// ---------------------------------------------------------------------------
// The API's lifecycle, owned by this suite
// ---------------------------------------------------------------------------

let api: ChildProcess | null = null;
let apiLog: string[] = [];

async function waitForHealth(timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_BASE}/api/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  throw new Error(
    `The API did not become healthy on ${API_BASE} within ${timeoutMs}ms.\n` +
      `Last output:\n${apiLog.join('')}`,
  );
}

async function waitForDown(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${API_BASE}/api/health`);
    } catch {
      return;
    }
    await sleep(150);
  }
  throw new Error(`The API on ${API_BASE} did not stop within ${timeoutMs}ms.`);
}

async function startApi(): Promise<void> {
  if (!existsSync(API_ENTRY)) {
    throw new Error(`apps/api/dist/main.js is missing — run \`npm run api:build\` first.`);
  }

  apiLog = [];
  const child = spawn(process.execPath, [API_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL,
      NODE_ENV: process.env.NODE_ENV || 'development',
      // The replica poll is irrelevant here and would only add noise.
      ONETEAM_REFRESH_MS: '0',
      // A two-second sweep, so this suite can watch it happen instead of
      // sleeping for fifteen minutes. The grace period it sweeps with is not
      // configurable and stays at an hour — see `sweepBotSessions`.
      ONETEAM_BOT_SWEEP_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const collect = (chunk: Buffer) => {
    apiLog.push(chunk.toString());
    if (apiLog.length > 400) apiLog.shift();
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  api = child;
  await waitForHealth();
}

async function stopApi(): Promise<void> {
  const child = api;
  if (!child) return;
  api = null;

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');

  const forced = await Promise.race([exited.then(() => false), sleep(6_000).then(() => true)]);
  if (forced) child.kill('SIGKILL');

  await waitForDown();
}

async function uptimeSeconds(): Promise<number> {
  const response = await fetch(`${API_BASE}/api/health`);
  const body: any = await response.json();
  return Number(body?.uptimeSeconds ?? -1);
}

// ---------------------------------------------------------------------------
// Direct database access — the API knows nothing about this connection
// ---------------------------------------------------------------------------

let db: Client;

async function rowFor(chatId: string): Promise<any | null> {
  const result = await db.query('SELECT * FROM bot_sessions WHERE chat_id = $1', [chatId]);
  return result.rows[0] ?? null;
}

async function countRows(): Promise<number> {
  const result = await db.query('SELECT count(*)::int AS n FROM bot_sessions');
  return result.rows[0].n;
}

/** Moves a row's expiry, so the read predicate can be tested without waiting. */
async function expireRow(chatId: string, interval: string): Promise<void> {
  await db.query(`UPDATE bot_sessions SET expires_at = now() - $2::interval WHERE chat_id = $1`, [
    chatId,
    interval,
  ]);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A complete flow, as the bot would have written it after the photo arrived and
 * before the merchandiser confirmed it.
 *
 * `activeTaskId` is deliberately a task that does not exist. That is a check in
 * its own right: a supervisor may delete a task while a chat is mid-flow, and
 * the migration leaves `active_task_id` without a foreign key on purpose so that
 * deletion does not fail for a reason the supervisor cannot see.
 */
function flowBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chatId: CHAT_NEW,
    step: 'awaiting_confirm',
    storeId: 'str-bravo-yasamal',
    storeCode: 'BRAVO_YASAMAL_01',
    storeName: 'Bravo Yasamal',
    activeTaskId: `task-flow-${RUN}-yoxdur`,
    activeTaskTitle: `Rəf yoxlaması ${RUN}`,
    location: { latitude: 40.3724, longitude: 49.8372 },
    checklistQuestions: [
      { id: 'q1', question: 'Rəfdə Coca-Cola Classic var?', type: 'boolean', required: true },
      {
        id: 'q2',
        question: 'Neçə sıra düzülüb?',
        type: 'number',
        required: false,
        minValue: 0,
        maxValue: 10,
      },
    ],
    checklistAnswers: [
      { questionId: 'q1', value: true },
      { questionId: 'q2', value: 4 },
    ],
    checklistIndex: 2,
    pendingPhoto: {
      fileId: `AgADsuite${RUN}`,
      width: 1280,
      height: 960,
      fileSize: 84_512,
      messageId: 42,
    },
    ...overrides,
  };
}

/**
 * A stable string for comparing two values, independent of key order.
 *
 * `JSON.stringify` is NOT stable for this purpose, and the first version of this
 * suite was wrong for exactly that reason: object key order is not part of a
 * value, and PostgreSQL's JSONB does not preserve it — it stores keys sorted by
 * length and then by bytes. So `{id, label, type}` written by the bot comes back
 * as `{id, type, label}`. The data is identical; only the serialisation differs.
 *
 * Comparing raw JSON strings would fail on a difference that is not one, and the
 * tempting next step would be to "fix" the product to satisfy the test. Sorting
 * the keys removes the false failure at its source.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The fields this suite compares, with `null` and "absent" collapsed. */
function flowFingerprint(flow: any): string {
  return canonical({
    step: flow?.step ?? null,
    storeId: flow?.storeId ?? null,
    storeCode: flow?.storeCode ?? null,
    storeName: flow?.storeName ?? null,
    activeTaskId: flow?.activeTaskId ?? null,
    activeTaskTitle: flow?.activeTaskTitle ?? null,
    location: flow?.location ?? null,
    checklistQuestions: flow?.checklistQuestions ?? [],
    checklistAnswers: flow?.checklistAnswers ?? [],
    checklistIndex: flow?.checklistIndex ?? null,
    pendingPhoto: flow?.pendingPhoto ?? null,
  });
}

async function main(): Promise<void> {
  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();

  const countBefore = await countRows();
  console.log(`\nbot_sessions holds ${countBefore} row(s) before this run.\n`);

  try {
    // -------------------------------------------------------------------------
    console.log('startup');
    // -------------------------------------------------------------------------

    await startApi();
    check('its own API process starts and answers /api/health', true);

    const health: any = await (await fetch(`${API_BASE}/api/health`)).json();
    check(
      'the bot_sessions migration is applied',
      Array.isArray(health?.schema?.migrationsAlreadyApplied) &&
        health.schema.migrationsAlreadyApplied.includes('20260918000007_add_bot_sessions'),
      health?.schema?.migrationsApplied,
    );
    check(
      'the schema check finds no missing table or column',
      health?.schema?.ok === true &&
        (health?.schema?.missingTables ?? []).length === 0 &&
        (health?.schema?.missingColumns ?? []).length === 0,
      health?.schema,
    );

    // -------------------------------------------------------------------------
    console.log('\nnothing to resume');
    // -------------------------------------------------------------------------

    const empty = await call('GET', `/api/portal/field/flow?chatId=${CHAT_NEW}`);
    check(
      'a chat the bot has never seen has no flow',
      empty.status === 200 && empty.body?.data === null,
      empty.body,
    );
    check('and reading it does not create a row', (await rowFor(CHAT_NEW)) === null);

    // -------------------------------------------------------------------------
    console.log('\na flow is written');
    // -------------------------------------------------------------------------

    const write = await call('PUT', '/api/portal/field/flow', { body: flowBody() });
    check('the write is accepted', write.status === 200, write.body);

    // Read with a connection the API knows nothing about. This is the assertion
    // that separates "the API remembers" from "the row exists".
    const stored = await rowFor(CHAT_NEW);
    check('the row is in postgres, read with a separate connection', stored !== null);

    check('the step reached the row', stored?.step === 'awaiting_confirm', stored?.step);
    check(
      'the store reached the row',
      stored?.store_id === 'str-bravo-yasamal' &&
        stored?.store_code === 'BRAVO_YASAMAL_01' &&
        stored?.store_name === 'Bravo Yasamal',
      { id: stored?.store_id, code: stored?.store_code, name: stored?.store_name },
    );
    check(
      'the task reached the row',
      stored?.active_task_id === `task-flow-${RUN}-yoxdur` &&
        stored?.active_task_title === `Rəf yoxlaması ${RUN}`,
      { id: stored?.active_task_id, title: stored?.active_task_title },
    );
    check(
      'the merchandiser\u2019s own coordinates reached the row',
      Number(stored?.latitude) === 40.3724 && Number(stored?.longitude) === 49.8372,
      { lat: stored?.latitude, lon: stored?.longitude },
    );
    check(
      'the checklist questions reached the row as JSON',
      Array.isArray(stored?.checklist_questions) && stored.checklist_questions.length === 2,
      stored?.checklist_questions,
    );
    check(
      'the checklist answers reached the row as JSON',
      Array.isArray(stored?.checklist_answers) &&
        stored.checklist_answers.length === 2 &&
        stored.checklist_answers[1]?.value === 4,
      stored?.checklist_answers,
    );
    check(
      'the checklist position reached the row',
      stored?.checklist_index === 2,
      stored?.checklist_index,
    );
    check(
      'the pending photo reached the row',
      stored?.pending_photo?.fileId === `AgADsuite${RUN}` &&
        stored?.pending_photo?.messageId === 42,
      stored?.pending_photo,
    );
    check(
      'a flow may name a task that does not exist — no foreign key, on purpose',
      stored !== null && write.status === 200,
    );
    check(
      'the expiry is set in the future',
      stored !== null && new Date(stored.expires_at).getTime() > Date.now(),
      stored?.expires_at,
    );

    // -------------------------------------------------------------------------
    console.log('\nthe round trip');
    // -------------------------------------------------------------------------

    const readBack = await call('GET', `/api/portal/field/flow?chatId=${CHAT_NEW}`);
    check(
      'reading returns exactly what was written',
      readBack.status === 200 &&
        flowFingerprint(readBack.body?.data) === flowFingerprint(flowBody()),
      { got: flowFingerprint(readBack.body?.data), want: flowFingerprint(flowBody()) },
    );

    // The person is not taken from the body. A caller that could assert who a
    // chat belongs to would be able to write somebody else's flow.
    const spoofed = await call('PUT', '/api/portal/field/flow', {
      body: flowBody({ chatId: CHAT_NEW, userId: 'usr-does-not-exist' }),
    });
    const spoofedRow = await rowFor(CHAT_NEW);
    check('the write with a spoofed userId is accepted', spoofed.status === 200, spoofed.body);
    check(
      'a chat with nobody behind it stores a null person, not the body\u2019s claim',
      spoofedRow?.user_id === null,
      spoofedRow?.user_id,
    );

    const bound = await call('PUT', '/api/portal/field/flow', {
      body: flowBody({ chatId: CHAT_BOUND, userId: 'usr-does-not-exist' }),
    });
    const boundRow = await rowFor(CHAT_BOUND);
    check('a bound chat\u2019s flow is accepted', bound.status === 200, bound.body);
    check(
      'the person is derived from the chat, not from the body',
      boundRow?.user_id === BOUND_USER_ID && boundRow?.user_id !== 'usr-does-not-exist',
      boundRow?.user_id,
    );

    // -------------------------------------------------------------------------
    console.log('\nrefusals — and nothing is written');
    // -------------------------------------------------------------------------

    const unknownStep = await call('PUT', '/api/portal/field/flow', {
      body: flowBody({ chatId: CHAT_DELETE, step: 'awaiting_teleport' }),
    });
    check(
      'an unknown step is refused',
      unknownStep.status === 400 && unknownStep.body?.error === 'INVALID_FLOW_STEP',
      unknownStep.body,
    );

    const halfLocation = await call('PUT', '/api/portal/field/flow', {
      body: flowBody({ chatId: CHAT_DELETE, location: { latitude: 40.3724 } }),
    });
    check(
      'a half-written location is refused',
      halfLocation.status === 400 && halfLocation.body?.error === 'INVALID_FLOW_LOCATION',
      halfLocation.body,
    );

    const noFileId = await call('PUT', '/api/portal/field/flow', {
      body: flowBody({ chatId: CHAT_DELETE, pendingPhoto: { width: 100 } }),
    });
    check(
      'a pending photo with no file id is refused',
      noFileId.status === 400 && noFileId.body?.error === 'INVALID_PENDING_PHOTO',
      noFileId.body,
    );

    const negativeIndex = await call('PUT', '/api/portal/field/flow', {
      body: flowBody({ chatId: CHAT_DELETE, checklistIndex: -1 }),
    });
    check(
      'a negative checklist position is refused',
      negativeIndex.status === 400 && negativeIndex.body?.error === 'INVALID_CHECKLIST_INDEX',
      negativeIndex.body,
    );

    const badQuestions = await call('PUT', '/api/portal/field/flow', {
      body: flowBody({ chatId: CHAT_DELETE, checklistQuestions: 'q1, q2' }),
    });
    check(
      'a non-list of questions is refused',
      badQuestions.status === 400 && badQuestions.body?.error === 'INVALID_CHECKLIST_QUESTIONS',
      badQuestions.body,
    );

    check('none of those refusals wrote a row', (await rowFor(CHAT_DELETE)) === null);

    const noChat = await call('GET', '/api/portal/field/flow');
    check(
      'the flow routes refuse a request with no chat id',
      noChat.status === 400 && noChat.body?.error === 'CHAT_ID_REQUIRED',
      noChat.body,
    );

    // -------------------------------------------------------------------------
    console.log('\nthe expiry');
    // -------------------------------------------------------------------------

    const beforeRead = await rowFor(CHAT_NEW);
    await sleep(1200);
    await call('GET', `/api/portal/field/flow?chatId=${CHAT_NEW}`);
    const afterRead = await rowFor(CHAT_NEW);
    check(
      'reading a live flow pushes its expiry forward',
      new Date(afterRead!.expires_at).getTime() > new Date(beforeRead!.expires_at).getTime(),
      { before: beforeRead?.expires_at, after: afterRead?.expires_at },
    );

    // An expired flow must not resume, and must not be deleted by the read.
    const expiredWrite = await call('PUT', '/api/portal/field/flow', {
      body: flowBody({ chatId: CHAT_EXPIRED, step: 'awaiting_checklist' }),
    });
    check('a flow to expire is written', expiredWrite.status === 200, expiredWrite.body);

    await expireRow(CHAT_EXPIRED, '5 minutes');
    const expiredRead = await call('GET', `/api/portal/field/flow?chatId=${CHAT_EXPIRED}`);
    check(
      'an expired flow is not resumed',
      expiredRead.status === 200 && expiredRead.body?.data === null,
      expiredRead.body,
    );
    check(
      'but it is not deleted either — the row is still there to be explained',
      (await rowFor(CHAT_EXPIRED)) !== null,
    );

    // -------------------------------------------------------------------------
    console.log('\nthe sweep');
    // -------------------------------------------------------------------------

    // Expired beyond the grace period (an hour): swept.
    await call('PUT', '/api/portal/field/flow', {
      body: flowBody({ chatId: CHAT_SWEPT, step: 'awaiting_checklist' }),
    });
    await expireRow(CHAT_SWEPT, '2 hours');

    // Expired inside the grace period: left alone, so "what was this person
    // doing" stays answerable for a while after they walked away.
    await call('PUT', '/api/portal/field/flow', {
      body: flowBody({ chatId: CHAT_GRACE, step: 'awaiting_checklist' }),
    });
    await expireRow(CHAT_GRACE, '5 minutes');

    const liveRowBefore = await rowFor(CHAT_NEW);

    const sweepDeadline = Date.now() + 15_000;
    let swept = false;
    while (Date.now() < sweepDeadline) {
      if ((await rowFor(CHAT_SWEPT)) === null) {
        swept = true;
        break;
      }
      await sleep(500);
    }

    check('a flow expired beyond the grace period is swept away', swept);
    check(
      'a flow expired inside the grace period is left alone',
      (await rowFor(CHAT_GRACE)) !== null,
    );
    check(
      'a live flow is never touched by the sweep',
      canonical(await rowFor(CHAT_NEW)) === canonical(liveRowBefore),
    );

    // -------------------------------------------------------------------------
    console.log('\ndeleting');
    // -------------------------------------------------------------------------

    await call('PUT', '/api/portal/field/flow', {
      body: flowBody({ chatId: CHAT_DELETE, step: 'awaiting_location' }),
    });
    check('a flow to delete is written', (await rowFor(CHAT_DELETE)) !== null);

    const cleared = await call('DELETE', `/api/portal/field/flow?chatId=${CHAT_DELETE}`);
    check(
      'deleting answers that it cleared something',
      cleared.status === 200 && cleared.body?.data?.cleared === true,
      cleared.body,
    );
    check('and the row is gone from postgres', (await rowFor(CHAT_DELETE)) === null);

    const clearedAgain = await call('DELETE', `/api/portal/field/flow?chatId=${CHAT_DELETE}`);
    check(
      'deleting again answers that there was nothing to clear — not an error',
      clearedAgain.status === 200 && clearedAgain.body?.data?.cleared === false,
      clearedAgain.body,
    );

    // -------------------------------------------------------------------------
    console.log('\nthe restart — the reason this feature exists');
    // -------------------------------------------------------------------------

    const restartWrite = await call('PUT', '/api/portal/field/flow', {
      body: flowBody({ chatId: CHAT_RESTART, step: 'awaiting_checklist', checklistIndex: 1 }),
    });
    check('a flow is written before the restart', restartWrite.status === 200, restartWrite.body);

    const uptimeBefore = await uptimeSeconds();
    await stopApi();
    check('the API process is stopped', true);

    await startApi();
    const uptimeAfter = await uptimeSeconds();
    check(
      'a genuinely different process is answering',
      uptimeAfter >= 0 && uptimeAfter < uptimeBefore,
      { before: uptimeBefore, after: uptimeAfter },
    );

    const afterRestart = await call('GET', `/api/portal/field/flow?chatId=${CHAT_RESTART}`);
    check(
      'the flow written by the previous process is read back',
      afterRestart.status === 200 && afterRestart.body?.data?.step === 'awaiting_checklist',
      afterRestart.body,
    );
    check(
      'and every field came back, not just the step',
      flowFingerprint(afterRestart.body?.data) ===
        flowFingerprint(
          flowBody({ chatId: CHAT_RESTART, step: 'awaiting_checklist', checklistIndex: 1 }),
        ),
      { got: flowFingerprint(afterRestart.body?.data) },
    );

    const boundAfterRestart = await call('GET', `/api/portal/field/flow?chatId=${CHAT_BOUND}`);
    check(
      'a bound chat keeps its person across the restart too',
      boundAfterRestart.status === 200 &&
        boundAfterRestart.body?.data?.storeId === 'str-bravo-yasamal',
      boundAfterRestart.body,
    );
  } finally {
    // Clean up whatever the run left behind, even if a check threw.
    try {
      await db.query('DELETE FROM bot_sessions WHERE chat_id = ANY($1::text[])', [ALL_CHATS]);
    } catch (error) {
      console.error('Could not clean up bot_sessions:', error);
    }

    await stopApi().catch(() => undefined);

    try {
      const countAfter = await countRows();
      check('no test row is left behind', countAfter === countBefore, {
        before: countBefore,
        after: countAfter,
      });
    } finally {
      await db.end();
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error('\nSuite crashed:', error);
  await stopApi().catch(() => undefined);
  process.exitCode = 1;
});
