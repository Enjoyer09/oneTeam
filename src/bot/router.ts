import { handleTasksPage } from './handlers/tasks';
/**
 * oneTeam Telegram Bot — the router
 * ============================================================================
 *
 * WHAT THIS FILE IS, AND WHY IT DID NOT EXIST
 * -------------------------------------------
 * Every handler in `handlers/` was written, and four of them were never called.
 * `index.ts` imported `handleLocationMessage`, `handleLocationSkip`,
 * `handleChecklistText` and `handleChecklistCallback` and wired none of them:
 *
 *   - there was no `message:location` route at all, so a shared location was
 *     dropped by Telegram's dispatcher and the bot said nothing;
 *   - the text route only ever reached the store-code branch;
 *   - the single callback route accepted `submit_` and ignored everything else,
 *     so a checklist button was swallowed without even an acknowledgement.
 *
 * The consequence was not a cosmetic one. The guided flow asks for a location
 * first and refuses a photo until it has one, so a merchandiser could open a
 * task, share their location, be ignored, and then be refused the photo because
 * the step had never advanced. The flow was unreachable end to end, and
 * `bot:test` was green throughout, because it calls the handlers directly and so
 * never crosses the layer that was broken.
 *
 * So the routes live in one place, in one function, where the whole surface can
 * be read at once. `router.test.ts` drives the real bot through
 * `bot.handleUpdate` and fails if a route disappears.
 *
 * ORDER IS PART OF THE DESIGN
 * ---------------------------
 * grammY runs middleware in registration order and stops at the first handler
 * that does not call `next()`. The order below is therefore not incidental, and
 * each entry says what would go wrong if it moved.
 */

import { Bot } from 'grammy';
import { AnswerCallback, BotContext } from './types';
import { parseCallback } from './callbacks';
import { MENU_STATUS_LABEL, MENU_TASKS_LABEL, MENU_TODAY_LABEL } from './keyboards';
import { handleStart, handleStoreCodeInput } from './handlers/start';
import { handleTasks, handleOpenTask, handleDiscardTask } from './handlers/tasks';
import { handleToday } from './handlers/today';
import {
  handleChecklistAnswer,
  handleChecklistText,
  handleLocationMessage,
  handleLocationSkip,
  handleRestartTask,
} from './handlers/taskFlow';
import { handleConfirmPhoto, handlePhotoArrival, handleRetakePhoto } from './handlers/submission';
import { handleMyStatus } from './handlers/status';
import { handleHelp, handleMenuHome } from './handlers/help';

/**
 * Attaches every route to the bot.
 *
 * Called once, from `createBot`. Kept separate from `index.ts` so that the
 * wiring can be read — and tested — without the polling, the token handling and
 * the retry loop around it.
 */
export function registerRoutes(bot: Bot<BotContext>): void {
  // Commands first. Phase 2.4 requires them to keep working even if every
  // button were unavailable, so they are the floor the rest is built on.
  bot.command('start', handleStart);
  bot.command('bugun', handleToday);
  bot.command('tasks', handleTasks);
  bot.command('mystatus', handleMyStatus);
  bot.command('help', handleHelp);

  // The reply keyboard's buttons, kept for the same reason. They are heard by
  // exact label, so the constants are shared rather than retyped.
  bot.hears(MENU_TODAY_LABEL, handleToday);
  bot.hears(MENU_TASKS_LABEL, handleTasks);
  bot.hears(MENU_STATUS_LABEL, handleMyStatus);

  // ONE callback route. It used to be `handleTaskSelectCallback`, which
  // understood a single prefix — see the file header.
  bot.on('callback_query:data', handleCallbackQuery);

  // A location message has no `text`, so this cannot collide with the text
  // route below; it is listed first only because the flow reaches it first.
  bot.on('message:location', async (ctx) => {
    await handleLocationMessage(ctx);
  });

  bot.on('message:photo', handlePhotoArrival);

  // The text route is last and claims everything else.
  bot.on('message:text', handleTextRoute);
}

/**
 * The text route, in the order the branches have to be tried.
 *
 * Each branch is a `return`, so a later branch cannot undo an earlier one. The
 * checklist branch is checked BEFORE the store-code pattern, because a store
 * code is `[A-Z0-9_]` and a typed checklist answer is a number — but a
 * merchandiser mid-checklist who types something code-shaped must still have it
 * read as an answer, not as an attempt to change store.
 */
export async function handleTextRoute(ctx: BotContext): Promise<void> {
  // 1. Nothing else is reachable while the chat has not said where it is. An
  //    answer stored before the store is known would belong to no task.
  if (ctx.session.step === 'awaiting_store_code') {
    await handleStoreCodeInput(ctx);
    return;
  }

  // 2. The location-skip button. Before the checklist, so the label is never
  //    mistaken for a typed answer.
  if (await handleLocationSkip(ctx)) return;

  // 3. A typed answer to a number question.
  if (await handleChecklistText(ctx)) return;

  // 4. A store code sent without /start. Kept because the old behaviour
  //    accepted one at any time, and a merchandiser who has lost their place
  //    reaches for their code before they reach for a command.
  const text = ctx.message?.text?.trim() ?? '';
  if (/^[A-Z0-9_]{4,30}$/i.test(text) && text.includes('_')) {
    await handleStoreCodeInput(ctx);
    return;
  }

  // 5. Nothing claimed it. Answering with the help text — rather than staying
  //    silent — is what stops an unrecognised message from reading as "the bot
  //    is down".
  await handleHelp(ctx);
}

/**
 * The callback route.
 *
 * ONE ANSWER, GUARANTEED
 * ----------------------
 * Telegram spins a button until its query is answered, and answering the same
 * query twice is a 400. Both are handled by `makeAnswerer`, which hands the
 * handlers a function that answers at most once — so no handler has to know
 * whether it is the first to speak, and the `finally` below guarantees the
 * spinner stops even when a handler throws.
 */
export async function handleCallbackQuery(ctx: BotContext): Promise<void> {
  const answer = makeAnswerer(ctx);
  const parsed = parseCallback(ctx.callbackQuery?.data);

  if (!parsed) {
    // A button this bot did not build, or one from a version that used a
    // different format. Saying so is better than a silent no-op, which reads as
    // the bot being broken.
    await answer('Bu düymə artıq keçərli deyil.');
    return;
  }

  try {
    switch (parsed.action) {
      case 'menu':
        await answer();
        await handleMenuHome(ctx);
        return;
      case 'today':
        await answer();
        await handleToday(ctx);
        return;
      case 'tasks':
        await answer();
        await handleTasksPage(ctx, /^page-\d+$/.test(parsed.id) ? Number(parsed.id.slice(5)) : 0);
        return;
      case 'status':
        await answer();
        await handleMyStatus(ctx);
        return;
      case 'help':
        await answer();
        await handleHelp(ctx);
        return;
      case 'open':
        // Answered inside, because the guard has to say something before the
        // slow work starts.
        await handleOpenTask(ctx, parsed.id, answer);
        return;
      case 'discard':
        await handleDiscardTask(ctx, parsed.id, answer);
        return;
      case 'restart':
        await handleRestartTask(ctx, parsed.id, answer);
        return;
      case 'chk':
        await handleChecklistAnswer(ctx, parsed.id, answer);
        return;
      case 'confirm':
        await handleConfirmPhoto(ctx, parsed.id, answer);
        return;
      case 'retake':
        await handleRetakePhoto(ctx, parsed.id, answer);
        return;
    }
  } finally {
    // Whatever happened above — including a throw — the button must stop
    // spinning. An unanswered query leaves the merchandiser tapping a button
    // that appears dead, which is how one photo becomes three.
    await answer();
  }
}

/**
 * Builds the once-only callback answerer.
 *
 * The catch is not defensive padding: a query that has expired cannot be
 * answered, Telegram says so with a 400, and that is not a reason to fail an
 * update whose actual work already succeeded.
 */
function makeAnswerer(ctx: BotContext): AnswerCallback {
  let answered = false;

  return async (toast?: string) => {
    if (answered) return;
    answered = true;

    try {
      await ctx.answerCallbackQuery(toast ? { text: toast } : {});
    } catch (error) {
      console.error('[oneTeam Bot] Could not answer a callback query:', error);
    }
  };
}
