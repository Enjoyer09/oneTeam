#!/usr/bin/env node
/**
 * Tests for the `task_<id>` deep link in `handleStart`.
 * ============================================================================
 *
 * `t.me/<bot>?start=task_<id>` arrives as `/start task_<id>`, and grammy hands
 * the payload to the command handler as `ctx.match`. This suite pins the wiring
 * that turns that payload into an opened task, without a DB: `getTaskById` and
 * `acknowledgeTask` are stubbed, and `beginTaskFlow` runs for real, so a
 * successful open leaves the session in `awaiting_location` exactly as a task
 * card tap would.
 *
 * WHAT IT ASSERTS
 * ---------------
 *   1. Enrolled + `task_<id>` (task exists) → the flow starts on that task.
 *   2. Enrolled + `task_<id>` (task gone) → a visible message, no flow started.
 *   3. Enrolled + no payload → the home screen, and no task is fetched.
 *   4. Not enrolled + `task_<id>` → the store-code prompt; the task is not fetched.
 */

import { handleStart } from './start';
import { portalApi } from '../../services/portalApi';
import type { BotContext, SessionData } from '../types';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✅ [PASS] ${label}`);
  } else {
    failed++;
    console.log(`  ❌ [FAIL] ${label}`);
    if (detail) console.log(`         ${detail}`);
  }
}

interface Captured {
  replies: string[];
}

function makeCtx(
  session: Partial<SessionData>,
  match: string,
): { ctx: BotContext; captured: Captured } {
  const captured: Captured = { replies: [] };
  const ctx = {
    match,
    session: { step: 'idle', ...session } as SessionData,
    chat: { id: 4242, type: 'private' },
    from: { id: 4242, is_bot: false, first_name: 'Eldar' },
    reply: async (text: string) => {
      captured.replies.push(text);
      return { message_id: 1 };
    },
  } as unknown as BotContext;
  return { ctx, captured };
}

function task(id: string, title: string) {
  return {
    id,
    title,
    description: 'x',
    reference_image_url: null,
    priority: 'HIGH',
    status: 'PUBLISHED',
    deadline: new Date().toISOString(),
    checklist_schema: [],
  };
}

async function run() {
  console.log('handleStart — the task_<id> deep link\n');

  const originalGetTask = portalApi.getTaskById.bind(portalApi);
  const originalAck = portalApi.acknowledgeTask.bind(portalApi);

  (portalApi as any).acknowledgeTask = async () => ({
    taskId: 'x',
    currentState: 'ACKNOWLEDGED',
    advanced: true,
  });

  try {
    // -----------------------------------------------------------------------
    // Enrolled + a live task → the guided flow starts on that task.
    // -----------------------------------------------------------------------
    {
      let fetchedId = '';
      (portalApi as any).getTaskById = async (id: string) => {
        fetchedId = id;
        return task(id, 'Soyuducu auditi');
      };
      const { ctx } = makeCtx({ storeId: 'store-1', storeName: 'Mağaza 1' }, 'task_task-9');
      await handleStart(ctx);
      check(
        'the deep-linked task is fetched by its id',
        fetchedId === 'task-9',
        `fetchedId=${fetchedId}`,
      );
      check(
        'the task becomes active and the flow reaches the location step',
        ctx.session.activeTaskId === 'task-9' && ctx.session.step === 'awaiting_location',
        `activeTaskId=${ctx.session.activeTaskId} step=${ctx.session.step}`,
      );
    }

    // -----------------------------------------------------------------------
    // Enrolled + a stale link (task gone) → a visible message, no flow.
    // -----------------------------------------------------------------------
    {
      (portalApi as any).getTaskById = async () => null;
      const { ctx, captured } = makeCtx(
        { storeId: 'store-1', storeName: 'Mağaza 1' },
        'task_missing',
      );
      await handleStart(ctx);
      check(
        'a stale deep link says so and starts no flow',
        (ctx.session.step ?? 'idle') === 'idle' &&
          ctx.session.activeTaskId === undefined &&
          captured.replies.some((r) => /tapılmadı/i.test(r)),
        `step=${ctx.session.step} activeTaskId=${ctx.session.activeTaskId} replies=${JSON.stringify(captured.replies)}`,
      );
    }

    // -----------------------------------------------------------------------
    // Enrolled + no payload → home screen, and no task is fetched.
    // -----------------------------------------------------------------------
    {
      let fetched = false;
      (portalApi as any).getTaskById = async () => {
        fetched = true;
        return null;
      };
      const { ctx, captured } = makeCtx({ storeId: 'store-1', storeName: 'Mağaza 1' }, '');
      await handleStart(ctx);
      check(
        'a plain /start goes home without fetching a task',
        fetched === false && captured.replies.length === 1,
        `fetched=${fetched} replies=${captured.replies.length}`,
      );
    }

    // -----------------------------------------------------------------------
    // Not enrolled + a deep link → the store-code prompt; no task fetched.
    // -----------------------------------------------------------------------
    {
      let fetched = false;
      (portalApi as any).getTaskById = async () => {
        fetched = true;
        return null;
      };
      const { ctx } = makeCtx({ storeId: undefined }, 'task_task-9');
      await handleStart(ctx);
      check(
        'an unenrolled deep link asks for the store code and fetches no task',
        fetched === false && ctx.session.step === 'awaiting_store_code',
        `fetched=${fetched} step=${ctx.session.step}`,
      );
    }
  } finally {
    (portalApi as any).getTaskById = originalGetTask;
    (portalApi as any).acknowledgeTask = originalAck;
  }

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
