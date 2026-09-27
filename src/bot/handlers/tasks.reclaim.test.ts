#!/usr/bin/env node
/**
 * Tests that opening a task re-claims the store's open work first.
 * ============================================================================
 *
 * THE BUG THIS GUARDS AGAINST
 * ---------------------------
 * "The store code is the claim": binding to a store assigns that store's
 * unassigned open tasks to the merchandiser who sent the code
 * (`FieldService.bind` → `claimStoreTasks`). That claim runs ONCE, at /start.
 *
 * A task a supervisor publishes in the panel AFTER the merchandiser bound is
 * therefore never claimed — its `assignedUserId` stays empty, and the API's
 * `canUserAccessTask` then refuses BOTH the acknowledge and the photo submission
 * with `403 Bu tapşırıq üçün icazə yoxdur`. The task card opens and then quietly
 * files nothing: the live IPHONE_TEST symptom, seen in the bot logs as repeated
 * `403` on `task-panel-1789826089870-msxtx6`.
 *
 * The fix re-binds (re-claims) for the session's store inside `handleOpenTask`,
 * before acknowledging, so a freshly-published task is claimed the moment the
 * merchandiser opens it. These checks drive `handleOpenTask` with the two API
 * calls stubbed and assert:
 *   - the re-claim happens, for the session's store, BEFORE the acknowledge;
 *   - it is skipped when no store is bound (never claim without store presence);
 *   - a failing re-claim is non-fatal — the flow still proceeds.
 *
 *   npm run test:reclaim-on-open
 */
import { portalApi } from '../../services/portalApi';
import { BotContext, TaskRecord } from '../types';
import { handleOpenTask } from './tasks';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  ✅ [PASS] ${label}`);
  } else {
    failed++;
    console.log(`  ❌ [FAIL] ${label}`);
    if (detail) console.log(`         ${detail}`);
  }
}

function makeCtx(storeId?: string) {
  const replies: string[] = [];
  const ctx = {
    session: { step: 'idle', checklistAnswers: [], ...(storeId ? { storeId } : {}) },
    chat: { id: 42, type: 'private' },
    from: { id: 7, first_name: 'Aysel', last_name: 'Məmmədova', username: 'aysel' },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: replies.length };
    },
    replyWithPhoto: async (_photo: unknown, options?: any) => {
      replies.push(options?.caption ?? '');
      return { message_id: replies.length };
    },
  } as unknown as BotContext;
  return { ctx, replies };
}

/** A panel-published task with no assignee — the shape that used to 403. */
function unclaimedPanelTask(): TaskRecord {
  return {
    id: 'task-panel-1789826089870-msxtx6',
    title: 'Raf yoxlaması',
    description: 'Rəfləri yoxlayın',
    priority: 'high',
    deadline: new Date('2026-10-01T09:00:00Z').toISOString(),
    checklist_schema: [],
    reference_image_url: '',
  } as unknown as TaskRecord;
}

async function main(): Promise<void> {
  console.log('tasks — re-claim the store on task open\n');

  const originalGet = portalApi.getTaskById;
  const originalAck = portalApi.acknowledgeTask;
  const originalBind = portalApi.bindTelegramUser;

  (portalApi as any).getTaskById = async () => unclaimedPanelTask();

  try {
    // 1. Store bound: the re-claim runs, for that store, before the acknowledge.
    {
      const calls: string[] = [];
      let boundStoreId = '';
      (portalApi as any).bindTelegramUser = async (params: any) => {
        calls.push('bind');
        boundStoreId = params.storeId;
        return { id: 'usr-tg-42', role: 'MERCHANDISER', claimedTaskIds: [params.storeId] };
      };
      (portalApi as any).acknowledgeTask = async () => {
        calls.push('ack');
        return { taskId: 'x', currentState: 'ACKNOWLEDGED', advanced: true };
      };

      const { ctx } = makeCtx('str-iphone-test');
      let threw = false;
      try {
        await handleOpenTask(ctx, 'task-panel-1789826089870-msxtx6', async () => {});
      } catch (error) {
        threw = true;
        console.log(`         handleOpenTask threw: ${(error as Error).message}`);
      }

      check('handleOpenTask does not throw', threw === false);
      check('the store is re-claimed on open', calls.includes('bind'), JSON.stringify(calls));
      check('the claim names the session store', boundStoreId === 'str-iphone-test', boundStoreId);
      check(
        'the claim happens BEFORE the acknowledge',
        calls.indexOf('bind') !== -1 &&
          calls.indexOf('ack') !== -1 &&
          calls.indexOf('bind') < calls.indexOf('ack'),
        JSON.stringify(calls),
      );
    }

    // 2. No store bound: never claim on behalf of a chat with no store presence.
    {
      const calls: string[] = [];
      (portalApi as any).bindTelegramUser = async () => {
        calls.push('bind');
        return { id: 'usr-tg-42', role: 'MERCHANDISER', claimedTaskIds: [] };
      };
      (portalApi as any).acknowledgeTask = async () => {
        calls.push('ack');
        return { taskId: 'x', currentState: 'ACKNOWLEDGED', advanced: true };
      };

      const { ctx } = makeCtx(); // no storeId
      await handleOpenTask(ctx, 'task-panel-1789826089870-msxtx6', async () => {});
      check('no re-claim without a bound store', !calls.includes('bind'), JSON.stringify(calls));
    }

    // 3. A failing re-claim is non-fatal — the flow still proceeds to acknowledge.
    {
      const calls: string[] = [];
      (portalApi as any).bindTelegramUser = async () => {
        throw new Error('bind unreachable');
      };
      (portalApi as any).acknowledgeTask = async () => {
        calls.push('ack');
        return { taskId: 'x', currentState: 'ACKNOWLEDGED', advanced: true };
      };

      const { ctx } = makeCtx('str-iphone-test');
      let threw = false;
      try {
        await handleOpenTask(ctx, 'task-panel-1789826089870-msxtx6', async () => {});
      } catch {
        threw = true;
      }
      check('a failing re-claim does not throw', threw === false);
      check('the flow still reaches the acknowledge', calls.includes('ack'), JSON.stringify(calls));
    }
  } finally {
    (portalApi as any).getTaskById = originalGet;
    (portalApi as any).acknowledgeTask = originalAck;
    (portalApi as any).bindTelegramUser = originalBind;
  }

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('The suite could not finish:', error);
  process.exit(1);
});
