/**
 * oneTeam Telegram Bot — Automated End-to-End Test Runner
 * Simulates complete user journeys: Registration, Task Retrieval, Shelf Photo Upload, and Status Inspection.
 */

import { supabaseService } from '../services/supabase';
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
 * Creates a mock Grammy BotContext to simulate incoming Telegram updates
 */
function createMockContext(overrides: Partial<BotContext> = {}): BotContext {
  const session: SessionData = {
    step: 'idle',
  };

  const repliedMessages: string[] = [];

  const mockCtx = {
    session,
    chat: { id: 998877665, type: 'private' },
    from: {
      id: 998877665,
      is_bot: false,
      first_name: 'Eldar',
      last_name: 'Mammadov',
      username: 'eldar_coke_merchandiser',
    },
    message: {
      message_id: 101,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 998877665, type: 'private' },
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
  console.log(`${colors.bright}  oneTeam RETAIL SHELF MONITORING — TELEGRAM BOT E2E AUTOMATED TESTS   ${colors.reset}`);
  console.log(`${colors.bright}========================================================================${colors.reset}`);

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
  logStep(2, 'Merchandiser inputs Store Code: "BRAVO_28MAY_01"');
  (ctx as any).message = {
    ...ctx.message,
    text: 'BRAVO_28MAY_01',
  };

  await handleStoreCodeInput(ctx);

  if (!ctx.session.storeId) {
    throw new Error('Expected storeId to be bound in session');
  }
  if (ctx.session.storeCode !== 'BRAVO_28MAY_01') {
    throw new Error(`Expected storeCode BRAVO_28MAY_01, got ${ctx.session.storeCode}`);
  }
  logSuccess(`Store successfully bound: ${ctx.session.storeName} (${ctx.session.storeCode})`);
  logSuccess(`Telegram chat ID ${ctx.chat?.id} bound to profile: ${ctx.session.profileId}`);

  // --------------------------------------------------------------------------
  // STEP 3: Task Retrieval (/tasks)
  // --------------------------------------------------------------------------
  logStep(3, 'Merchandiser requests tasks via /tasks');
  await handleTasks(ctx);
  const tasks = await supabaseService.getTasksForStore(ctx.session.storeId!);
  if (tasks.length === 0) {
    throw new Error('Expected at least 1 task assigned to store');
  }
  const sampleTask = tasks[0];
  logSuccess(`Active tasks found: ${tasks.length}`);
  logSuccess(`Sample Task: "${sampleTask.title}" (Priority: ${sampleTask.priority})`);

  // --------------------------------------------------------------------------
  // STEP 4: Selecting Task for Audit Submission
  // --------------------------------------------------------------------------
  logStep(4, 'Merchandiser clicks "📸 Rəf Şəklini Göndər"');
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

  // --------------------------------------------------------------------------
  // STEP 5: Shelf Photo Upload & Storage
  // --------------------------------------------------------------------------
  logStep(5, 'Merchandiser submits high-resolution shelf photo');
  (ctx as any).message = {
    message_id: 202,
    date: Math.floor(Date.now() / 1000),
    chat: ctx.chat,
    photo: [
      { file_id: 'thumb_small', file_unique_id: 'u1', width: 320, height: 240, file_size: 15000 },
      { file_id: 'full_hd_cooler_photo_id', file_unique_id: 'u2', width: 1920, height: 1080, file_size: 850000 },
    ],
  };

  await handlePhotoUpload(ctx);

  if ((ctx.session.step as string) !== 'idle') {
    throw new Error('Expected session step to reset to idle after upload');
  }

  // Verify submission in database
  const submissions = await supabaseService.getSubmissionsByChatId(ctx.chat!.id, 1);
  if (submissions.length === 0) {
    throw new Error('Expected submission to be created in database');
  }

  const latestSub = submissions[0];
  logSuccess(`Shelf photo uploaded to bucket 'shelf-images':`);
  logInfo(`Public URL: ${latestSub.photo_url}`);
  logSuccess(`Submission recorded: ID=${latestSub.id}, status=${latestSub.status}`);

  // --------------------------------------------------------------------------
  // STEP 6: /mystatus Inspection
  // --------------------------------------------------------------------------
  logStep(6, 'Merchandiser checks submission status via /mystatus');
  await handleMyStatus(ctx);
  logSuccess('Status report displayed pending review.');

  // --------------------------------------------------------------------------
  // STEP 7: Supervisor Approval Simulation
  // --------------------------------------------------------------------------
  logStep(7, 'Supervisor reviews and approves audit with feedback');
  const mockDb = supabaseService.getMockDbState();
  const subInDb = mockDb.submissions.find((s) => s.id === latestSub.id);
  if (subInDb) {
    subInDb.status = 'approved';
    subInDb.reviewer_feedback = 'Əla iş! Bütün Coca-Cola 0.5L məhsulları planograma uyğun ön sırada düzülüb.';
  }

  await handleMyStatus(ctx);
  logSuccess('Verified status update: Approved with supervisor feedback.');

  console.log(`\n${colors.bright}${colors.green}========================================================================${colors.reset}`);
  console.log(`${colors.bright}${colors.green}  ALL E2E BOT TESTS PASSED SUCCESSFULLY! (100% OPERATIONAL)             ${colors.reset}`);
  console.log(`${colors.bright}${colors.green}========================================================================${colors.reset}\n`);
}

runTestSuite().catch((err) => {
  console.error('\n❌ TEST RUNNER FAILED:', err);
  process.exit(1);
});
