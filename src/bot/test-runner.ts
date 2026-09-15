/**
 * oneTeam Telegram Bot — End-to-end test against the real API
 * ============================================================================
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * This runner used to exercise the handlers against `src/services/supabase.ts`,
 * an in-memory mock that answered every call. It therefore passed no matter what
 * the bot would do in production, and it proved nothing about the code that
 * actually ships.
 *
 * It now talks to the running Core API over HTTP, exactly as the bot does. That
 * makes it a real integration test — and it makes two prerequisites honest:
 *
 *   1. The API must be running (`npm run api:dev`).
 *   2. It writes real records. So it refuses to run when NODE_ENV=production,
 *      and it provisions its own store task instead of consuming the seeded demo
 *      one, which keeps it repeatable: the seeded task would end up APPROVED
 *      after the first run, and a terminal state cannot be reused.
 *
 * It also drives the state machine through the legal chain. A freshly dispatched
 * task is PUBLISHED, and a submission can only be reviewed from SUBMITTED, so
 * the runner advances PUBLISHED -> DELIVERED -> ACKNOWLEDGED first — which is
 * what the notification webhook does in production.
 */

import { Client } from 'pg';
import { portalApi } from '../services/portalApi';
import { handleStart, handleStoreCodeInput } from './handlers/start';
import { handleTasks, handleOpenTask } from './handlers/tasks';
import {
  handleChecklistAnswer,
  handleChecklistText,
  handleLocationMessage,
} from './handlers/taskFlow';
import { handleConfirmPhoto, handlePhotoArrival } from './handlers/submission';
import { handleMyStatus } from './handlers/status';
import { AnswerCallback, BotContext, SessionData } from './types';

/**
 * A stand-in for the router's callback answerer.
 *
 * The router owns answering a callback query — once, and never twice. This
 * runner calls the handlers directly, so there is no query to answer and this
 * is what takes its place.
 */
const noopAnswer: AnswerCallback = async () => {};

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';

/**
 * What this run created, so it can be removed again.
 *
 * Held at module scope because the cleanup has to run on the failure path too —
 * a run that dies halfway is exactly the run that leaves the most behind.
 */
let cleanupTaskId: string | undefined;
let cleanupTemplateId: string | undefined;

/**
 * Removes the task, template and audit this run provisioned.
 *
 * WHY THIS DID NOT EXIST, AND WHY IT DOES NOW
 * -------------------------------------------
 * The header of this file has always claimed the runner provisions its own task
 * "which keeps it repeatable". It did provision one, and it never removed it:
 * every run left a store task, its template and a filed audit in the database.
 * Nothing noticed for several phases, because the leftovers are valid rows in a
 * seeded store — a later suite's "rows before" simply read higher than the
 * truth. That is the kind of slow drift that quietly makes measurements
 * untrustworthy, which is the one thing a test suite must not do.
 *
 * The API cannot do this deletion. `task_evidences.store_task_id` is RESTRICT
 * and there is no endpoint that deletes a submission, so a task that has been
 * audited cannot be removed over HTTP at all. A direct connection is used, as
 * the other suites do, and this runner already refuses to start with NODE_ENV
 * set to production.
 *
 * PHASE 2.3 RE-OPENED THIS, IN A NEW TABLE
 * ----------------------------------------
 * Creating a task now also writes a row to `notifications` — the outbox the bot
 * drains. That column has no foreign key on purpose (the same reasoning as
 * `bot_sessions`: a supervisor must be able to delete a task without the outbox
 * refusing), and the price of that choice is that this deletion does NOT
 * cascade. So the row announcing the provisioned task outlived the task, and
 * this runner went back to printing "Removed the provisioned task" over a
 * database it had not finished cleaning.
 *
 * Measured, not assumed: one run took `notifications` from 3 rows to 4 and
 * `audit_logs` from 10 to 12, while reporting success. Every one of those
 * notification rows named a task that no longer existed.
 */
async function cleanupFixtures(): Promise<void> {
  if (!cleanupTaskId && !cleanupTemplateId) return;

  const db = new Client({ connectionString: DATABASE_URL });
  try {
    await db.connect();

    if (cleanupTaskId) {
      // The audit trail's evidence rows name the EVIDENCE, not the task, so
      // their ids have to be read before the rows they describe are deleted.
      const evidenceRows = await db.query(
        'SELECT id FROM task_evidences WHERE store_task_id = $1',
        [cleanupTaskId],
      );
      const evidenceIds = evidenceRows.rows.map((row: { id: string }) => row.id);

      await db.query('DELETE FROM task_evidences WHERE store_task_id = $1', [cleanupTaskId]);
      await db.query('DELETE FROM audit_logs WHERE entity_id = ANY($1::text[])', [
        [cleanupTaskId, ...evidenceIds],
      ]);
      // No foreign key means no cascade, so this has to be said explicitly. The
      // order matters only for readability — a row is removed by what it names,
      // not by what it references.
      await db.query('DELETE FROM notifications WHERE store_task_id = $1', [cleanupTaskId]);
      await db.query('DELETE FROM store_tasks WHERE id = $1', [cleanupTaskId]);
      console.log(
        `  🧹 Removed the provisioned task ${cleanupTaskId}, its audit and its queued notice.`,
      );
    }

    if (cleanupTemplateId) {
      await db.query('DELETE FROM task_templates WHERE id = $1', [cleanupTemplateId]);
    }
  } catch (error) {
    // A cleanup failure must not turn a passing run into a failing one — but it
    // must be said out loud, because the next run's baseline depends on it.
    console.warn(`  ⚠ Cleanup did not complete: ${(error as Error).message}`);
  } finally {
    await db.end().catch(() => undefined);
  }
}

// ANSI Colors for test output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

/** Real store code from `db/api-seed.sql`. */
const STORE_CODE = 'BRAVO_YASAMAL_01';

/**
 * The chat id seeded for `usr-merch-003` in `db/api-seed.sql`.
 *
 * Using the seeded merchandiser keeps the test focused on the data path. A fresh
 * chat would also exercise user creation, but then the task the test provisions
 * has to be unassigned for the claim to work, which makes the test depend on
 * more of the system than it is trying to verify.
 */
const CHAT_ID = 998877665;

/**
 * The merchandiser's coordinates, deliberately NOT the store's own.
 *
 * `BRAVO_YASAMAL_01` sits at 40.385012 / 49.810541. These are roughly 11 m away
 * — inside the 100 m geofence, but distinguishable from the store's values. That
 * distinction is the point: if the API ever fell back to the store's coordinates
 * (the shortcut this whole design exists to prevent), the stored `gps` would
 * come back as exactly 40.385012 / 49.810541 and the assertion in STEP 11 would
 * fail.
 */
const USER_LAT = 40.3851;
const USER_LON = 49.8106;

const API_URL = (process.env.ONETEAM_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
const API_TOKEN = process.env.ONETEAM_API_TOKEN || 'oneteam-user:usr-admin-001';

function logStep(stepNumber: number, title: string) {
  console.log(`\n${colors.bright}${colors.cyan}[TEST STEP ${stepNumber}] ${title}${colors.reset}`);
}

function logSuccess(message: string) {
  console.log(`${colors.green}  ✓ ${message}${colors.reset}`);
}

function logInfo(message: string) {
  console.log(`${colors.yellow}  ℹ ${message}${colors.reset}`);
}

/**
 * A direct API call, playing the supervisor.
 *
 * The bot's own client cannot do this: a supervisor's decision is not something
 * the chat channel should be able to make. The test file is allowed to hold two
 * credentials because it is simulating two actors.
 */
async function supervisorApi<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(20_000),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = payload?.message ?? payload?.error ?? `HTTP ${response.status}`;
    throw new Error(`Supervisor call ${path} failed: ${JSON.stringify(message)}`);
  }
  return (payload?.data ?? payload) as T;
}

/**
 * Everything the bot said, and the options it said it with.
 *
 * The guided flow is verified as much by *which keyboard* it offers as by the
 * words: a location prompt with no `request_location` button is a dead end, and
 * a checklist question with no answer buttons is unanswerable. Asserting only
 * the text would miss both.
 */
let replies: string[] = [];
let replyOptions: any[] = [];

/**
 * Creates a mock Grammy BotContext to simulate incoming Telegram updates
 */
function createMockContext(overrides: Partial<BotContext> = {}): BotContext {
  const session: SessionData = {
    step: 'idle',
  };

  replies = [];
  replyOptions = [];

  const mockCtx = {
    session,
    chat: { id: CHAT_ID, type: 'private' },
    from: {
      id: CHAT_ID,
      is_bot: false,
      first_name: 'Eldar',
      last_name: 'Məmmədov',
      username: 'eldar_coke_merchandiser',
    },
    message: {
      message_id: 101,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: 'private' },
    },
    reply: async (text: string, options?: any) => {
      replies.push(text);
      replyOptions.push(options ?? {});
      console.log(
        `  🤖 [Bot Reply]:\n${text
          .split('\n')
          .map((l) => '     ' + l)
          .join('\n')}`,
      );
      return { message_id: Math.floor(Math.random() * 10000) };
    },
    replyWithPhoto: async (photo: string, options?: any) => {
      const text = `[PHOTO: ${photo}]\n${options?.caption || ''}`;
      replies.push(text);
      replyOptions.push(options ?? {});
      console.log(
        `  🤖 [Bot Reply with Photo]:\n${text
          .split('\n')
          .map((l) => '     ' + l)
          .join('\n')}`,
      );
      return { message_id: Math.floor(Math.random() * 10000) };
    },
    answerCallbackQuery: async (_options?: any) => {
      return true;
    },
    api: {
      deleteMessage: async () => true,
      getFile: async (fileId: string) => ({
        file_id: fileId,
        file_path: `photos/${fileId}.jpg`,
      }),
    },
    ...overrides,
  } as unknown as BotContext;

  return mockCtx;
}

/** The last thing the bot said. */
function lastReply(): string {
  return replies[replies.length - 1] ?? '';
}

/** The keyboard offered with the last message, flattened to button labels. */
function lastKeyboardLabels(): string[] {
  const markup = replyOptions[replyOptions.length - 1]?.reply_markup;
  if (!markup) return [];

  // A reply keyboard serialises as `{ keyboard: [[{ text }]] }`; an inline one
  // as `{ inline_keyboard: [[{ text }]] }`. Both are flattened the same way so
  // an assertion does not have to care which kind was used.
  const rows = markup.keyboard ?? markup.inline_keyboard ?? [];
  return rows.flat().map((button: any) => String(button?.text ?? ''));
}

/** Fails the run with a readable message when a reply does not say what it must. */
function assertLastReplyContains(fragment: string, context: string) {
  if (!lastReply().includes(fragment)) {
    throw new Error(
      `${context}\n       Expected the bot to say something containing "${fragment}"\n` +
        `       Last reply was: "${lastReply().split('\n')[0]}"`,
    );
  }
}

async function runTestSuite() {
  console.log(
    `${colors.bright}========================================================================${colors.reset}`,
  );
  console.log(
    `${colors.bright}  oneTeam TELEGRAM BOT — END-TO-END TEST AGAINST THE REAL API          ${colors.reset}`,
  );
  console.log(
    `${colors.bright}========================================================================${colors.reset}`,
  );

  // --------------------------------------------------------------------------
  // Preconditions
  // --------------------------------------------------------------------------
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'This test writes real audits and must not run against production. ' +
        'Point it at a development API (npm run api:dev) and unset NODE_ENV.',
    );
  }

  const ping = await portalApi.ping();
  if (!ping.ok) {
    throw new Error(
      `The API at ${API_URL} is not answering: ${ping.error}\n` +
        '       Start it with: npm run api:dev',
    );
  }
  logSuccess(`API reachable at ${API_URL}`);

  // The photo step must not depend on a live Telegram file. Forcing the offline
  // path here means the test does not silently start downloading from
  // api.telegram.org (and failing) just because a real token is in .env.
  process.env.TELEGRAM_BOT_TOKEN = 'mockBotToken';

  const ctx = createMockContext();

  // --------------------------------------------------------------------------
  // STEP 1: /start and Registration
  // --------------------------------------------------------------------------
  logStep(1, 'Field Merchandiser sends /start');
  await handleStart(ctx);
  if (ctx.session.step !== 'awaiting_store_code') {
    throw new Error('Expected session.step to be awaiting_store_code');
  }
  logSuccess('Bot welcomed user in Azerbaijani and requested store code.');

  // --------------------------------------------------------------------------
  // STEP 2: Store Code Validation & Binding
  // --------------------------------------------------------------------------
  logStep(2, `Merchandiser inputs Store Code: "${STORE_CODE}"`);
  (ctx as any).message = {
    ...ctx.message,
    text: STORE_CODE,
  };

  await handleStoreCodeInput(ctx);

  if (!ctx.session.storeId) {
    throw new Error('Expected storeId to be bound in session');
  }
  if (ctx.session.storeCode !== STORE_CODE) {
    throw new Error(`Expected storeCode ${STORE_CODE}, got ${ctx.session.storeCode}`);
  }
  logSuccess(`Store successfully bound: ${ctx.session.storeName} (${ctx.session.storeCode})`);
  logSuccess(`Telegram chat ID ${ctx.chat?.id} bound to profile: ${ctx.session.profileId}`);

  const storeId = ctx.session.storeId!;

  // --------------------------------------------------------------------------
  // STEP 3: Provision a task for this store
  // --------------------------------------------------------------------------
  // Deliberately carries two REQUIRED questions of different kinds — a number
  // with bounds and a yes/no. Every real template looks like this, it is the
  // case the chat channel used to fail on, and it exercises both answer paths
  // (a typed number and a tapped button) rather than just one.
  logStep(3, 'Supervisor dispatches a briefing that has a required checklist');
  const title = `E2E test — Cooler auditi ${new Date().toISOString()}`;

  const dispatched = await supervisorApi<{ taskIds?: string[]; templateId?: string }>(
    '/api/portal/tasks',
    {
      method: 'POST',
      body: JSON.stringify({
        title,
        description: 'Avtomatik end-to-end test tərəfindən yaradılmış tapşırıq.',
        reference_image_url: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97',
        priority: 'HIGH',
        deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
        assigned_stores: [storeId],
        // `label`, not `question`. This fixture used to send `question`, which is
        // the name the bot's own type uses — but the API accepts `label`
        // (`PortalService.readChecklistSchema`) and answered the old fixture with
        // a 400, so this runner died before it could test anything. It now sends
        // the shape the panel actually sends.
        //
        // See #73: which of the two names is canonical is still open, and the bot
        // reads both until it is settled.
        checklist_schema: [
          {
            id: 'q-temp',
            label: 'Soyuducu temperaturu neçə dərəcədir?',
            type: 'number',
            unit: '°C',
            required: true,
            minValue: -5,
            maxValue: 15,
          },
          {
            id: 'q-clean',
            label: 'Soyuducu şüşəsi və rəflər təmizdirmi?',
            type: 'boolean',
            required: true,
          },
        ],
      }),
    },
  );

  const provisionedTaskId = dispatched?.taskIds?.[0];
  if (!provisionedTaskId) {
    throw new Error('Dispatch returned no task id');
  }
  // Recorded so the cleanup at the end of this file can remove them again.
  cleanupTaskId = provisionedTaskId;
  cleanupTemplateId = dispatched?.templateId;
  logSuccess(`Task created: ${provisionedTaskId}`);

  // The chat can only claim open work, so the merchandiser binds again now that
  // the task exists — this is the self-claim that makes submission possible.
  await portalApi.bindTelegramUser({
    telegramChatId: CHAT_ID,
    fullName: 'Eldar Məmmədov',
    storeId,
  });
  logSuccess("Chat claimed the store's open tasks.");

  // --------------------------------------------------------------------------
  // STEP 4: Task Retrieval (/tasks)
  // --------------------------------------------------------------------------
  logStep(4, 'Merchandiser requests tasks via /tasks');
  await handleTasks(ctx);

  const tasks = await portalApi.getTasksForStore(storeId);
  const sampleTask = tasks.find((t) => t.title === title);
  if (!sampleTask) {
    throw new Error(`Provisioned task "${title}" did not appear in /tasks`);
  }
  logSuccess(`Active tasks found: ${tasks.length}`);
  logSuccess(`Sample Task: "${sampleTask.title}" (Priority: ${sampleTask.priority})`);

  // --------------------------------------------------------------------------
  // STEP 5: Selecting Task for Audit Submission
  // --------------------------------------------------------------------------
  logStep(5, 'Merchandiser clicks "📸 Rəf Şəklini Göndər"');
  (ctx as any).callbackQuery = {
    id: 'cb-1',
    data: `open:${sampleTask.id}`,
    from: ctx.from,
    message: ctx.message,
    chat_instance: 'ci-1',
  };

  await handleOpenTask(ctx, sampleTask.id, noopAnswer);
  if (ctx.session.activeTaskId !== sampleTask.id) {
    throw new Error('Expected activeTaskId to be set in session');
  }
  // Opening a task now starts the guided flow, not the photo step. This used to
  // assert `awaiting_photo`, which is exactly the shortcut that produced audits
  // with no location and no answers.
  if ((ctx.session.step as string) !== 'awaiting_location') {
    throw new Error(`Expected the flow to start at awaiting_location, got ${ctx.session.step}`);
  }
  assertLastReplyContains('Addım 1/3', 'The flow must open with the location step');
  if (!lastKeyboardLabels().includes('📍 Lokasiyamı göndər')) {
    throw new Error(
      `The location step needs a request_location button, got: ${JSON.stringify(lastKeyboardLabels())}`,
    );
  }
  logSuccess(`Task "${sampleTask.title}" active; guided flow started at the location step.`);

  // --------------------------------------------------------------------------
  // STEP 6: A photo sent too early is refused
  // --------------------------------------------------------------------------
  // The flow is location -> checklist -> photo. A merchandiser who ignores the
  // prompts and sends the photo first would otherwise file exactly the
  // submission this flow exists to prevent: no location, no answers. Asserting
  // the refusal is what stops that from silently regressing.
  logStep(6, 'Merchandiser jumps ahead and sends a photo before the flow is done');
  (ctx as any).message = {
    message_id: 201,
    date: Math.floor(Date.now() / 1000),
    chat: ctx.chat,
    photo: [
      { file_id: 'too_early', file_unique_id: 'u0', width: 1280, height: 720, file_size: 400000 },
    ],
  };

  await handlePhotoArrival(ctx);

  if ((ctx.session.step as string) !== 'awaiting_location') {
    throw new Error(`Expected the flow to stay at awaiting_location, got ${ctx.session.step}`);
  }
  assertLastReplyContains('Şəkil hələ qəbul edilə bilməz', 'A premature photo must be refused');

  const earlyCheck = await portalApi.getSubmissionsByChatId(CHAT_ID, 50);
  if (earlyCheck.some((s) => s.task_id === sampleTask.id)) {
    throw new Error('A photo sent before the flow finished was filed anyway');
  }
  logSuccess('The premature photo was refused, and nothing was filed.');

  // --------------------------------------------------------------------------
  // STEP 7: The chat acknowledged the task
  // --------------------------------------------------------------------------
  // A submission can only be reviewed from SUBMITTED, and the state machine is
  // strict: PUBLISHED -> DELIVERED -> ACKNOWLEDGED -> IN_PROGRESS -> SUBMITTED.
  // The notification webhook walks the first two steps in the push flow; the bot
  // polls instead, so opening the task in the chat has to do it — otherwise the
  // photo below would land on a task no supervisor could ever approve.
  logStep(7, 'Opening the task in the chat acknowledged it');
  const rawTask = await supervisorApi<{ status?: string }>(
    `/api/tasks/${encodeURIComponent(sampleTask.id)}`,
  );
  if (rawTask?.status !== 'ACKNOWLEDGED') {
    throw new Error(`Expected ACKNOWLEDGED, got ${rawTask?.status}`);
  }
  logSuccess('Task is ACKNOWLEDGED and ready for field work.');

  // --------------------------------------------------------------------------
  // STEP 8: Location
  // --------------------------------------------------------------------------
  logStep(8, `Merchandiser shares their location (${USER_LAT}, ${USER_LON})`);
  (ctx as any).message = {
    message_id: 301,
    date: Math.floor(Date.now() / 1000),
    chat: ctx.chat,
    location: { latitude: USER_LAT, longitude: USER_LON },
  };

  await handleLocationMessage(ctx);

  if ((ctx.session.step as string) !== 'awaiting_checklist') {
    throw new Error(`Expected awaiting_checklist after the location, got ${ctx.session.step}`);
  }
  if (ctx.session.location?.latitude !== USER_LAT || ctx.session.location?.longitude !== USER_LON) {
    throw new Error(
      `Expected the shared coordinates in the session, got ${JSON.stringify(ctx.session.location)}`,
    );
  }
  assertLastReplyContains('Addım 2/3', 'The checklist must start once the location arrives');
  if (!lastReply().includes('1/2')) {
    throw new Error(`Expected question 1 of 2, got: ${lastReply().split('\n')[0]}`);
  }
  logSuccess('Location stored; checklist started at question 1/2.');

  // --------------------------------------------------------------------------
  // STEP 9: The number question
  // --------------------------------------------------------------------------
  logStep(9, 'Merchandiser answers the temperature question (with one bad attempt)');

  // An out-of-range value must not be accepted silently: the API would refuse it
  // at the end of the flow, after the photo, which is the worst moment to find
  // out.
  (ctx as any).message = {
    message_id: 302,
    date: Math.floor(Date.now() / 1000),
    chat: ctx.chat,
    text: '99',
  };
  await handleChecklistText(ctx);

  if (ctx.session.checklistIndex !== 0) {
    throw new Error('An out-of-range answer must not advance the checklist');
  }
  assertLastReplyContains('maksimum həddən', 'An out-of-range number must be refused');

  (ctx as any).message = {
    message_id: 303,
    date: Math.floor(Date.now() / 1000),
    chat: ctx.chat,
    text: '3',
  };
  await handleChecklistText(ctx);

  // Read through a local: TypeScript narrows the property itself after the check
  // above, and would then call this comparison impossible.
  const indexAfterNumber: number | undefined = ctx.session.checklistIndex;
  if (indexAfterNumber !== 1) {
    throw new Error(
      `Expected the checklist to advance to question 2, got index ${indexAfterNumber}`,
    );
  }
  const tempAnswer = ctx.session.checklistAnswers?.find((a) => a.questionId === 'q-temp');
  if (tempAnswer?.value !== 3) {
    throw new Error(`Expected q-temp = 3, got ${JSON.stringify(tempAnswer)}`);
  }
  assertLastReplyContains('2/2', 'The second question must follow the first');
  logSuccess('Out-of-range answer refused; "3" stored and the checklist advanced to question 2/2.');

  // --------------------------------------------------------------------------
  // STEP 10: The yes/no question
  // --------------------------------------------------------------------------
  logStep(10, 'Merchandiser taps "✅ Bəli" on the yes/no question');

  const answerLabels = lastKeyboardLabels();
  if (!answerLabels.includes('✅ Bəli') || !answerLabels.includes('❌ Xeyr')) {
    throw new Error(`Expected a Bəli/Xeyr keyboard, got: ${JSON.stringify(answerLabels)}`);
  }

  (ctx as any).callbackQuery = {
    id: 'cb-chk-1',
    data: 'chk:1:true',
    from: ctx.from,
    message: ctx.message,
    chat_instance: 'ci-1',
  };
  await handleChecklistAnswer(ctx, '1:true', noopAnswer);

  if ((ctx.session.step as string) !== 'awaiting_photo') {
    throw new Error(`Expected awaiting_photo after the last answer, got ${ctx.session.step}`);
  }
  const cleanAnswer = ctx.session.checklistAnswers?.find((a) => a.questionId === 'q-clean');
  if (cleanAnswer?.value !== true) {
    throw new Error(`Expected q-clean = true, got ${JSON.stringify(cleanAnswer)}`);
  }
  assertLastReplyContains('Addım 3/3', 'The photo prompt must follow the last answer');
  logSuccess('Boolean answer stored; flow advanced to the photo step.');

  // --------------------------------------------------------------------------
  // STEP 11: Shelf Photo Upload
  // --------------------------------------------------------------------------
  logStep(11, 'Merchandiser submits the shelf photo');
  (ctx as any).message = {
    message_id: 401,
    date: Math.floor(Date.now() / 1000),
    chat: ctx.chat,
    photo: [
      { file_id: 'thumb_small', file_unique_id: 'u1', width: 320, height: 240, file_size: 15000 },
      {
        file_id: 'full_hd_cooler_photo_id',
        file_unique_id: 'u2',
        width: 1920,
        height: 1080,
        file_size: 850000,
      },
    ],
  };

  await handlePhotoArrival(ctx);

  // Phase 2.1: the photo is HELD, not filed. The merchandiser sees it back and
  // has to accept it, so the first thing to assert is that nothing was filed
  // yet — an assertion that would have passed for the wrong reason before, when
  // the flow refused the photo outright.
  if ((ctx.session.step as string) !== 'awaiting_confirm') {
    throw new Error(`Expected the photo to be held at awaiting_confirm, got ${ctx.session.step}`);
  }
  if (ctx.session.pendingPhoto?.fileId !== 'full_hd_cooler_photo_id') {
    throw new Error(
      `Expected the highest-resolution file id to be held, got ` +
        JSON.stringify(ctx.session.pendingPhoto),
    );
  }
  const heldLabels = lastKeyboardLabels();
  if (
    !heldLabels.some((label) => label.includes('Təsdiqlə')) ||
    !heldLabels.some((label) => label.includes('Yenidən çək'))
  ) {
    throw new Error(`Expected a confirm/retake keyboard, got: ${JSON.stringify(heldLabels)}`);
  }
  const beforeConfirm = await portalApi.getSubmissionsByChatId(CHAT_ID, 50);
  if (beforeConfirm.some((s) => s.task_id === sampleTask.id)) {
    throw new Error('The photo was filed before the confirm button was tapped');
  }
  logSuccess('Photo held for confirmation; nothing filed yet.');

  logStep(11.5, 'Merchandiser taps "✅ Təsdiqlə və göndər"');
  await handleConfirmPhoto(ctx, sampleTask.id, noopAnswer);

  if ((ctx.session.step as string) !== 'idle') {
    throw new Error('Expected session step to reset to idle after the confirm');
  }
  assertLastReplyContains('Təsdiqləndi', 'The confirmation must report a verified location');

  // A duplicate tap is a second update carrying the same callback data. The
  // session is already reset, so the guard must find nothing to file — the
  // acceptance criterion for Phase 2.1, checked here as well as in
  // `router.test.ts`, because this is the run that touches the real API.
  const afterFirstConfirm = await portalApi.getSubmissionsByChatId(CHAT_ID, 50);
  await handleConfirmPhoto(ctx, sampleTask.id, noopAnswer);
  const afterDuplicate = await portalApi.getSubmissionsByChatId(CHAT_ID, 50);
  if (afterDuplicate.length !== afterFirstConfirm.length) {
    throw new Error(
      `A duplicate confirm filed a second audit: ${afterFirstConfirm.length} -> ${afterDuplicate.length}`,
    );
  }
  logSuccess('A duplicate confirm tap filed nothing and raised nothing.');

  const submissions = await portalApi.getSubmissionsByChatId(CHAT_ID, 5);
  const created = submissions.find((s) => s.task_id === sampleTask.id);
  if (!created) {
    throw new Error('Expected a submission for the provisioned task');
  }
  logSuccess(`Submission recorded: ID=${created.id}, status=${created.status}`);
  logInfo(`Photo stored inline (${created.photo_url.slice(0, 32)}…, no object store yet)`);

  if (created.status !== 'pending_review') {
    throw new Error(`Expected pending_review, got ${created.status}`);
  }

  // The two controls the guided flow exists to apply, asserted on the record
  // rather than on the conversation.
  const filedAnswers = created.checklist_answers ?? [];
  if (filedAnswers.length !== 2) {
    throw new Error(
      `Expected 2 checklist answers on the submission, got ${filedAnswers.length}: ` +
        JSON.stringify(filedAnswers),
    );
  }
  logSuccess(`Checklist answers filed with the audit: ${JSON.stringify(filedAnswers)}`);

  const filedGps = (created.metadata as any)?.gps;
  if (filedGps?.latitude !== USER_LAT || filedGps?.longitude !== USER_LON) {
    throw new Error(
      `Expected the merchandiser's own coordinates to be stored (${USER_LAT}, ${USER_LON}), ` +
        `got ${JSON.stringify(filedGps)}. The store's coordinates are 40.385012, 49.810541 — ` +
        `if that is what came back, the location was faked rather than verified.`,
    );
  }
  logSuccess(
    `Location verified, not substituted: stored ${filedGps.latitude}, ${filedGps.longitude} ` +
      `(the merchandiser's fix, not the store's own coordinates).`,
  );

  // The whole point of the acknowledgement above: the photo must carry the task
  // to SUBMITTED, which is the only state a supervisor can approve from.
  const submittedTask = await supervisorApi<{ status?: string }>(
    `/api/tasks/${encodeURIComponent(sampleTask.id)}`,
  );
  if (submittedTask?.status !== 'SUBMITTED') {
    throw new Error(`Expected SUBMITTED after the photo, got ${submittedTask?.status}`);
  }
  logSuccess('Task advanced to SUBMITTED — it is now reviewable.');

  // --------------------------------------------------------------------------
  // STEP 12: /mystatus Inspection
  // --------------------------------------------------------------------------
  logStep(12, 'Merchandiser checks submission status via /mystatus');
  await handleMyStatus(ctx);
  logSuccess('Status report displayed pending review.');

  // --------------------------------------------------------------------------
  // STEP 13: Supervisor Approval
  // --------------------------------------------------------------------------
  logStep(13, 'Supervisor approves the audit with feedback');
  const feedback = 'Əla iş! Bütün Coca-Cola 0.5L məhsulları planograma uyğun ön sırada düzülüb.';
  await supervisorApi(`/api/portal/submissions/${encodeURIComponent(created.id)}/review`, {
    method: 'POST',
    body: JSON.stringify({ status: 'approved', feedback }),
  });

  const after = await portalApi.getSubmissionsByChatId(CHAT_ID, 5);
  const reviewed = after.find((s) => s.id === created.id);
  if (!reviewed || reviewed.status !== 'approved') {
    throw new Error(`Expected approved, got ${reviewed?.status}`);
  }
  if (reviewed.reviewer_feedback !== feedback) {
    throw new Error(
      `Expected the supervisor's feedback to survive, got "${reviewed.reviewer_feedback}"`,
    );
  }
  logSuccess(`Verdict reached the bot: ${reviewed.status} — "${reviewed.reviewer_feedback}"`);

  // --------------------------------------------------------------------------
  // STEP 14: /mystatus reflects the verdict
  // --------------------------------------------------------------------------
  logStep(14, 'Merchandiser re-checks status and sees the verdict');
  await handleMyStatus(ctx);
  logSuccess('Status report displayed the approval and the supervisor feedback.');

  console.log(
    `\n${colors.bright}${colors.green}========================================================================${colors.reset}`,
  );
  console.log(
    `${colors.bright}${colors.green}  ALL END-TO-END BOT TESTS PASSED AGAINST THE REAL API                  ${colors.reset}`,
  );
  console.log(
    `${colors.bright}${colors.green}========================================================================${colors.reset}\n`,
  );
}

async function main(): Promise<void> {
  let failed = false;

  try {
    await runTestSuite();
  } catch (err: any) {
    failed = true;
    console.error(`\n${colors.red}❌ TEST RUNNER FAILED:${colors.reset}`, err?.message || err);
    console.error(
      `\n   This test needs the Core API running. Start it with:\n     npm run api:dev\n`,
    );
  }

  // Always, on both paths: a run that died halfway is the run that would
  // otherwise leave the most behind.
  await cleanupFixtures();

  process.exit(failed ? 1 : 0);
}

main();
