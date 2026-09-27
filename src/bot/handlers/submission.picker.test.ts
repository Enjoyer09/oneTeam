#!/usr/bin/env node
/**
 * Tests for the "photo arrived with no task open" branch of handlePhotoArrival.
 * ============================================================================
 *
 * WHY THIS EXISTS AS ITS OWN SUITE
 * --------------------------------
 * The end-to-end bot suites (`bot:test`, `test:router`) drive the real bot
 * against a live API and Postgres, and they exercise the HAPPY path: open a task
 * from `/tasks`, share a location, answer the checklist, then send the photo. By
 * construction they always have an `activeTaskId` by the time a photo arrives, so
 * the branch a merchandiser actually hits — "I took a photo and sent it without
 * opening a task first" — was never covered, and it was a dead end: the bot
 * refused the photo and pointed at a menu that does not list tasks.
 *
 * This suite covers exactly that branch, and it needs no database: the only API
 * call the branch makes is `getTasksForStore`, which is stubbed here. So it runs
 * in the in-memory tier (`test:all`) alongside the other pure suites.
 *
 * WHAT IT ASSERTS
 * ---------------
 *   1. A photo with no task open is NOT filed — no submission call is made.
 *   2. The store's active tasks are offered as one-tap `open:<id>` buttons, so
 *      selecting one is immediate rather than a hunt through the menu.
 *   3. A store with no active tasks gets a plain "nothing to do" reply, not a
 *      dead end that reads as the bot being broken.
 *   4. An API failure degrades to a "try again" reply instead of throwing the
 *      update on the floor.
 */

import { handlePhotoArrival } from './submission';
import { portalApi } from '../../services/portalApi';
import type { BotContext, SessionData, TaskRecord } from '../types';

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
  options: any[];
}

/**
 * A minimal grammy context for the photo handler. Only the surface the handler
 * touches is present; anything it reaches for that is missing would fail the
 * test loudly, which is the point.
 */
function makeCtx(session: Partial<SessionData>): { ctx: BotContext; captured: Captured } {
  const captured: Captured = { replies: [], options: [] };

  const ctx = {
    session: { step: 'idle', ...session } as SessionData,
    chat: { id: 4242, type: 'private' },
    from: { id: 4242, is_bot: false, first_name: 'Eldar' },
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 4242, type: 'private' },
      photo: [{ file_id: 'unattached-photo', width: 800, height: 600, file_size: 1234 }],
    },
    reply: async (text: string, options?: any) => {
      captured.replies.push(text);
      captured.options.push(options ?? {});
      return { message_id: 1 };
    },
    replyWithPhoto: async (_photo: string, options?: any) => {
      captured.replies.push(`[PHOTO]\n${options?.caption ?? ''}`);
      captured.options.push(options ?? {});
      return { message_id: 1 };
    },
  } as unknown as BotContext;

  return { ctx, captured };
}

/** Flattens the last reply's inline keyboard to `{ text, data }` buttons. */
function lastInlineButtons(captured: Captured): Array<{ text: string; data: string }> {
  const markup = captured.options[captured.options.length - 1]?.reply_markup;
  const rows = markup?.inline_keyboard ?? [];
  return rows
    .flat()
    .map((b: any) => ({ text: String(b?.text ?? ''), data: String(b?.callback_data ?? '') }));
}

function task(id: string, title: string): TaskRecord {
  return {
    id,
    title,
    description: 'x',
    reference_image_url: null,
    priority: 'HIGH' as TaskRecord['priority'],
    status: 'PUBLISHED' as TaskRecord['status'],
    deadline: new Date().toISOString(),
  };
}

async function run() {
  console.log('handlePhotoArrival — the no-task-open branch\n');

  const originalGetTasks = portalApi.getTasksForStore.bind(portalApi);
  const originalCreate = portalApi.createSubmission.bind(portalApi);

  // A photo must never be filed from this branch. If the handler ever tries,
  // this stub records it so the assertion can fail rather than silently
  // reaching a live API.
  let submissionAttempted = false;
  (portalApi as any).createSubmission = async () => {
    submissionAttempted = true;
    throw new Error('createSubmission must not be called from the no-task branch');
  };

  try {
    // -----------------------------------------------------------------------
    // One active task → a single one-tap open button, and nothing filed.
    // -----------------------------------------------------------------------
    (portalApi as any).getTasksForStore = async () => [task('task-1', 'Cooler auditi')];
    {
      const { ctx, captured } = makeCtx({ storeId: 'store-1', activeTaskId: undefined });
      await handlePhotoArrival(ctx);

      const buttons = lastInlineButtons(captured);
      check(
        'a loose photo is not filed',
        submissionAttempted === false,
        'the handler tried to create a submission with no task selected',
      );
      check(
        'the one active task is offered as an open: button',
        buttons.some((b) => b.data === 'open:task-1'),
        `buttons were: ${JSON.stringify(buttons)}`,
      );
      check(
        'the task title is shown on the button, not a bare id',
        buttons.some((b) => b.text.includes('Cooler auditi')),
        `buttons were: ${JSON.stringify(buttons)}`,
      );
      check(
        'the session is left untouched (no task auto-selected)',
        ctx.session.activeTaskId === undefined && (ctx.session.step ?? 'idle') === 'idle',
        `step=${ctx.session.step} activeTaskId=${ctx.session.activeTaskId}`,
      );
    }

    // -----------------------------------------------------------------------
    // Several active tasks → one open: button each, so the merchandiser picks
    // the right one in context.
    // -----------------------------------------------------------------------
    (portalApi as any).getTasksForStore = async () => [
      task('task-a', 'Rəf A'),
      task('task-b', 'Rəf B'),
      task('task-c', 'Rəf C'),
    ];
    {
      const { ctx, captured } = makeCtx({ storeId: 'store-1', activeTaskId: undefined });
      await handlePhotoArrival(ctx);

      const openButtons = lastInlineButtons(captured).filter((b) => b.data.startsWith('open:'));
      check(
        'every active task gets its own open: button',
        openButtons.length === 3 &&
          ['open:task-a', 'open:task-b', 'open:task-c'].every((d) =>
            openButtons.some((b) => b.data === d),
          ),
        `open buttons were: ${JSON.stringify(openButtons)}`,
      );
    }

    // -----------------------------------------------------------------------
    // No active tasks → an honest "nothing to do" reply, no crash.
    // -----------------------------------------------------------------------
    (portalApi as any).getTasksForStore = async () => [];
    {
      const { ctx, captured } = makeCtx({ storeId: 'store-1', activeTaskId: undefined });
      await handlePhotoArrival(ctx);
      check(
        'an empty task list produces a reply rather than an error',
        captured.replies.length === 1 && /tapşırıq/i.test(captured.replies[0]),
        `last reply: ${captured.replies[captured.replies.length - 1]}`,
      );
    }

    // -----------------------------------------------------------------------
    // API failure → a graceful "try again", not a thrown update.
    // -----------------------------------------------------------------------
    (portalApi as any).getTasksForStore = async () => {
      throw new Error('boom');
    };
    {
      const { ctx, captured } = makeCtx({ storeId: 'store-1', activeTaskId: undefined });
      let threw = false;
      try {
        await handlePhotoArrival(ctx);
      } catch {
        threw = true;
      }
      check(
        'an API failure is caught and answered, not thrown',
        threw === false && captured.replies.length === 1,
        threw ? 'the handler threw instead of replying' : 'no reply was produced',
      );
    }

    // -----------------------------------------------------------------------
    // No store bound → the store-registration prompt still wins, and the task
    // lookup is never even attempted.
    // -----------------------------------------------------------------------
    let lookupCalled = false;
    (portalApi as any).getTasksForStore = async () => {
      lookupCalled = true;
      return [];
    };
    {
      const { ctx, captured } = makeCtx({ storeId: undefined, activeTaskId: undefined });
      await handlePhotoArrival(ctx);
      check(
        'a photo with no store bound asks for /start and does not look up tasks',
        lookupCalled === false && /start/i.test(captured.replies[0] ?? ''),
        `lookupCalled=${lookupCalled} reply=${captured.replies[0]}`,
      );
    }
  } finally {
    (portalApi as any).getTasksForStore = originalGetTasks;
    (portalApi as any).createSubmission = originalCreate;
  }

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
