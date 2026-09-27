#!/usr/bin/env node
/**
 * Tests for the "🗓 Bugün" day-at-a-glance screen (`handleToday`).
 * ============================================================================
 *
 * WHY THIS EXISTS AS ITS OWN SUITE
 * --------------------------------
 * The screen aggregates two reads — the store's open tasks and the chat's recent
 * submissions — and computes "today" itself, in the store's timezone. That
 * arithmetic is exactly the kind that is right in the demo and wrong at 00:30,
 * so it is pinned here rather than left to the live E2E suites (which need a DB
 * and never assert the day boundary). Both API calls are stubbed, so it runs in
 * the in-memory tier (`test:all`).
 *
 * WHAT IT ASSERTS
 * ---------------
 *   1. No store bound → the /start prompt, and neither read is attempted.
 *   2. Open tasks are counted, and each is offered as a one-tap `open:` button.
 *   3. Only submissions dated *today* (Asia/Baku) are counted as today's.
 *   4. An API failure degrades to a "try again" reply instead of throwing.
 */

import { handleToday } from './today';
import { portalApi } from '../../services/portalApi';
import type { BotContext, SessionData, SubmissionRecord, TaskRecord } from '../types';

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

function makeCtx(session: Partial<SessionData>): { ctx: BotContext; captured: Captured } {
  const captured: Captured = { replies: [], options: [] };
  const ctx = {
    session: { step: 'idle', ...session } as SessionData,
    chat: { id: 4242, type: 'private' },
    from: { id: 4242, is_bot: false, first_name: 'Eldar' },
    reply: async (text: string, options?: any) => {
      captured.replies.push(text);
      captured.options.push(options ?? {});
      return { message_id: 1 };
    },
  } as unknown as BotContext;
  return { ctx, captured };
}

/** Every inline button across every reply, flattened to `{ text, data }`. */
function allInlineButtons(captured: Captured): Array<{ text: string; data: string }> {
  const out: Array<{ text: string; data: string }> = [];
  for (const opt of captured.options) {
    const rows = opt?.reply_markup?.inline_keyboard ?? [];
    for (const b of rows.flat()) {
      out.push({ text: String(b?.text ?? ''), data: String(b?.callback_data ?? '') });
    }
  }
  return out;
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

function submission(status: SubmissionRecord['status'], submittedAt: string): SubmissionRecord {
  return {
    id: `sub-${Math.random().toString(36).slice(2)}`,
    task_id: 't',
    store_id: 's',
    photo_url: 'data:image/jpeg;base64,xxx',
    status,
    reviewer_feedback: null,
    submitted_at: submittedAt,
    task: { title: 'Rəf auditi' },
  };
}

/** A timestamp that renders as "today" / "yesterday" in Asia/Baku. */
function bakuOffsetIso(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  // Noon UTC lands on the same calendar day in Baku (UTC+4), so the day math is
  // unambiguous regardless of when the suite runs.
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString();
}

async function run() {
  console.log('handleToday — the day-at-a-glance screen\n');

  const originalGetTasks = portalApi.getTasksForStore.bind(portalApi);
  const originalGetSubs = portalApi.getSubmissionsByChatId.bind(portalApi);

  try {
    // -----------------------------------------------------------------------
    // No store bound → /start prompt, and neither read is attempted.
    // -----------------------------------------------------------------------
    {
      let taskLookup = false;
      let subLookup = false;
      (portalApi as any).getTasksForStore = async () => {
        taskLookup = true;
        return [];
      };
      (portalApi as any).getSubmissionsByChatId = async () => {
        subLookup = true;
        return [];
      };
      const { ctx, captured } = makeCtx({ storeId: undefined });
      await handleToday(ctx);
      check(
        'no store bound asks for /start and reads nothing',
        taskLookup === false && subLookup === false && /start/i.test(captured.replies[0] ?? ''),
        `taskLookup=${taskLookup} subLookup=${subLookup} reply=${captured.replies[0]}`,
      );
    }

    // -----------------------------------------------------------------------
    // Open tasks are counted and offered as one-tap open: buttons.
    // -----------------------------------------------------------------------
    {
      (portalApi as any).getTasksForStore = async () => [
        task('task-a', 'Rəf A'),
        task('task-b', 'Rəf B'),
      ];
      (portalApi as any).getSubmissionsByChatId = async () => [];
      const { ctx, captured } = makeCtx({ storeId: 'store-1', storeName: 'Mağaza 1' });
      await handleToday(ctx);

      const openButtons = allInlineButtons(captured).filter((b) => b.data.startsWith('open:'));
      check(
        'the overview reports the open-task count',
        captured.replies.some((r) => /Açıq tapşırıq:\*?\s*2/.test(r)),
        `replies: ${JSON.stringify(captured.replies)}`,
      );
      check(
        'each open task gets its own open: shortcut button',
        openButtons.length === 2 &&
          ['open:task-a', 'open:task-b'].every((d) => openButtons.some((b) => b.data === d)),
        `open buttons: ${JSON.stringify(openButtons)}`,
      );
    }

    // -----------------------------------------------------------------------
    // Only today's submissions are counted as today's.
    // -----------------------------------------------------------------------
    {
      (portalApi as any).getTasksForStore = async () => [];
      (portalApi as any).getSubmissionsByChatId = async () => [
        submission('approved', bakuOffsetIso(0)), // today
        submission('pending_review', bakuOffsetIso(0)), // today
        submission('approved', bakuOffsetIso(3)), // three days ago
      ];
      const { ctx, captured } = makeCtx({ storeId: 'store-1', storeName: 'Mağaza 1' });
      await handleToday(ctx);
      check(
        "today's submissions are counted, older ones excluded",
        captured.replies.some((r) => /Bu gün göndərilən:\*?\s*2/.test(r)),
        `replies: ${JSON.stringify(captured.replies)}`,
      );
    }

    // -----------------------------------------------------------------------
    // API failure → graceful reply, not a thrown update.
    // -----------------------------------------------------------------------
    {
      (portalApi as any).getTasksForStore = async () => {
        throw new Error('boom');
      };
      (portalApi as any).getSubmissionsByChatId = async () => [];
      const { ctx, captured } = makeCtx({ storeId: 'store-1', storeName: 'Mağaza 1' });
      let threw = false;
      try {
        await handleToday(ctx);
      } catch {
        threw = true;
      }
      check(
        'an API failure is caught and answered, not thrown',
        threw === false && captured.replies.length === 1 && /yenidən/i.test(captured.replies[0]),
        threw ? 'the handler threw' : `reply: ${captured.replies[0]}`,
      );
    }
  } finally {
    (portalApi as any).getTasksForStore = originalGetTasks;
    (portalApi as any).getSubmissionsByChatId = originalGetSubs;
  }

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
