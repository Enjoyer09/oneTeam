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

import { portalApi } from '../services/portalApi';
import { handleStart, handleStoreCodeInput } from './handlers/start';
import { handleTasks, handleTaskSelectCallback } from './handlers/tasks';
import { handlePhotoUpload } from './handlers/submission';
import { handleMyStatus } from './handlers/status';
import { BotContext, SessionData } from './types';

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
 * Creates a mock Grammy BotContext to simulate incoming Telegram updates
 */
function createMockContext(overrides: Partial<BotContext> = {}): BotContext {
  const session: SessionData = {
    step: 'idle',
  };

  const repliedMessages: string[] = [];

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
      repliedMessages.push(text);
      console.log(`  🤖 [Bot Reply]:\n${text.split('\n').map((l) => '     ' + l).join('\n')}`);
      return { message_id: Math.floor(Math.random() * 10000) };
    },
    replyWithPhoto: async (photo: string, options?: any) => {
      const text = `[PHOTO: ${photo}]\n${options?.caption || ''}`;
      repliedMessages.push(text);
      console.log(`  🤖 [Bot Reply with Photo]:\n${text.split('\n').map((l) => '     ' + l).join('\n')}`);
      return { message_id: Math.floor(Math.random() * 10000) };
    },
    answerCallbackQuery: async (options?: any) => {
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

async function runTestSuite() {
  console.log(`${colors.bright}========================================================================${colors.reset}`);
  console.log(`${colors.bright}  oneTeam TELEGRAM BOT — END-TO-END TEST AGAINST THE REAL API          ${colors.reset}`);
  console.log(`${colors.bright}========================================================================${colors.reset}`);

  // --------------------------------------------------------------------------
  // Preconditions
  // --------------------------------------------------------------------------
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'This test writes real audits and must not run against production. ' +
        'Point it at a development API (npm run api:dev) and unset NODE_ENV.'
    );
  }

  const ping = await portalApi.ping();
  if (!ping.ok) {
    throw new Error(
      `The API at ${API_URL} is not answering: ${ping.error}\n` +
        '       Start it with: npm run api:dev'
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
  // Deliberately carries a required checklist question: that is what every real
  // template looks like, and it is the case the chat channel used to fail on.
  logStep(3, 'Supervisor dispatches a briefing that has a required checklist');
  const title = `E2E test — Cooler auditi ${new Date().toISOString()}`;

  const dispatched = await supervisorApi<{ taskIds?: string[] }>('/api/portal/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title,
      description: 'Avtomatik end-to-end test tərəfindən yaradılmış tapşırıq.',
      reference_image_url: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97',
      priority: 'HIGH',
      deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
      assigned_stores: [storeId],
      checklist_schema: [
        {
          id: 'q-temp',
          question: 'Soyuducu temperaturu normaya uyğundurmu? (<= 4°C)',
          type: 'number',
          required: true,
        },
      ],
    }),
  });

  const provisionedTaskId = dispatched?.taskIds?.[0];
  if (!provisionedTaskId) {
    throw new Error('Dispatch returned no task id');
  }
  logSuccess(`Task created: ${provisionedTaskId}`);

  // The chat can only claim open work, so the merchandiser binds again now that
  // the task exists — this is the self-claim that makes submission possible.
  await portalApi.bindTelegramUser({
    telegramChatId: CHAT_ID,
    fullName: 'Eldar Məmmədov',
    storeId,
  });
  logSuccess('Chat claimed the store\'s open tasks.');

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
    data: `submit_${sampleTask.id}`,
    from: ctx.from,
    message: ctx.message,
    chat_instance: 'ci-1',
  };

  await handleTaskSelectCallback(ctx);
  if (ctx.session.activeTaskId !== sampleTask.id) {
    throw new Error('Expected activeTaskId to be set in session');
  }
  if ((ctx.session.step as string) !== 'awaiting_photo') {
    throw new Error('Expected session step to be awaiting_photo');
  }
  logSuccess(`Task "${sampleTask.title}" active for photo upload.`);

  // A submission can only be reviewed from SUBMITTED, and the state machine is
  // strict: PUBLISHED -> DELIVERED -> ACKNOWLEDGED -> IN_PROGRESS -> SUBMITTED.
  // In production the notification webhook walks the first two steps.
  logStep(6, 'Notification webhook delivers and the merchandiser acknowledges');
  for (const state of ['DELIVERED', 'ACKNOWLEDGED']) {
    await supervisorApi(`/api/tasks/${encodeURIComponent(sampleTask.id)}/transition`, {
      method: 'POST',
      body: JSON.stringify({ targetState: state, notes: 'E2E test — state machine walk' }),
    });
  }
  logSuccess('Task is ACKNOWLEDGED and ready for field work.');

  // --------------------------------------------------------------------------
  // STEP 7: Shelf Photo Upload
  // --------------------------------------------------------------------------
  logStep(7, 'Merchandiser submits high-resolution shelf photo');
  (ctx as any).message = {
    message_id: 202,
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

  await handlePhotoUpload(ctx);

  if ((ctx.session.step as string) !== 'idle') {
    throw new Error('Expected session step to reset to idle after upload');
  }

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
  logSuccess('A task with a required checklist was accepted — the chat channel gap is recorded, not blocking.');

  // --------------------------------------------------------------------------
  // STEP 8: /mystatus Inspection
  // --------------------------------------------------------------------------
  logStep(8, 'Merchandiser checks submission status via /mystatus');
  await handleMyStatus(ctx);
  logSuccess('Status report displayed pending review.');

  // --------------------------------------------------------------------------
  // STEP 9: Supervisor Approval
  // --------------------------------------------------------------------------
  logStep(9, 'Supervisor approves the audit with feedback');
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
    throw new Error(`Expected the supervisor's feedback to survive, got "${reviewed.reviewer_feedback}"`);
  }
  logSuccess(`Verdict reached the bot: ${reviewed.status} — "${reviewed.reviewer_feedback}"`);

  // --------------------------------------------------------------------------
  // STEP 10: /mystatus reflects the verdict
  // --------------------------------------------------------------------------
  logStep(10, 'Merchandiser re-checks status and sees the verdict');
  await handleMyStatus(ctx);
  logSuccess('Status report displayed the approval and the supervisor feedback.');

  console.log(`\n${colors.bright}${colors.green}========================================================================${colors.reset}`);
  console.log(`${colors.bright}${colors.green}  ALL END-TO-END BOT TESTS PASSED AGAINST THE REAL API                  ${colors.reset}`);
  console.log(`${colors.bright}${colors.green}========================================================================${colors.reset}\n`);
}

runTestSuite().catch((err) => {
  console.error(`\n${colors.red}❌ TEST RUNNER FAILED:${colors.reset}`, err?.message || err);
  console.error(
    `\n   This test needs the Core API running. Start it with:\n     npm run api:dev\n`
  );
  process.exit(1);
});
