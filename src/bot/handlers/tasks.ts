import { InlineKeyboard } from 'grammy';
import { AnswerCallback, BotContext, TaskRecord } from '../types';
import { portalApi, PortalApiError } from '../../services/portalApi';
import { encodeCallback } from '../callbacks';
import { mainMenuKeyboard } from '../keyboards';
import { escapeMarkdown } from '../markdown';
import { beginTaskFlow, resumeCurrentStep } from './taskFlow';

export async function handleTasks(ctx: BotContext) {
  if (!ctx.session.storeId) {
    await ctx.reply(
      `⚠️ *Mağaza qeydiyyatı tapılmadı!*\n\nZəhmət olmasa əvvəlcə /start əmrini göndərib mağaza kodunuzu daxil edin.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  let tasks;
  try {
    tasks = await portalApi.getTasksForStore(ctx.session.storeId);
  } catch (error) {
    const detail = error instanceof PortalApiError ? error.message : String(error);
    console.error(`[oneTeam Bot] Task lookup failed for ${ctx.session.storeId}:`, detail);
    await ctx.reply(
      `❌ *Tapşırıqları yükləmək mümkün olmadı.*\n\nZəhmət olmasa bir az sonra yenidən cəhd edin.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  if (tasks.length === 0) {
    await ctx.reply(
      `ℹ️ *${escapeMarkdown(ctx.session.storeName ?? '')}* mağazası üçün hazırda aktiv rəf tapşırığı yoxdur.`,
      { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() },
    );
    return;
  }

  // The header carries the durable reply keyboard, so that a merchandiser who
  // arrived here by typing `/tasks` has the buttons back under the message box.
  // The task cards below carry their own inline `open:` buttons, which belong
  // to the card they are on.
  await ctx.reply(
    `📋 *${escapeMarkdown(ctx.session.storeName ?? '')}* üçün aktiv tapşırıqlar (${tasks.length}):`,
    {
      parse_mode: 'Markdown',
      reply_markup: mainMenuKeyboard(),
    },
  );

  for (const task of tasks) {
    await sendTaskDetails(ctx, task);
  }
}

export async function sendTaskDetails(ctx: BotContext, task: TaskRecord) {
  const priorityIcons: Record<string, string> = {
    urgent: '🔴 Təcili',
    high: '🟠 Yüksək',
    medium: '🟡 Orta',
    low: '🟢 Aşağı',
  };

  const priorityLabel = priorityIcons[task.priority] || task.priority;
  const deadlineStr = new Date(task.deadline).toLocaleString('az-AZ', {
    timeZone: 'Asia/Baku',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  // Saying how many questions the audit will ask is not decoration: the
  // merchandiser is about to be walked through them, and knowing that up front
  // is the difference between "the bot is interrogating me" and "this is the
  // audit".
  const questionCount = task.checklist_schema?.length ?? 0;
  const checklistLine = questionCount > 0 ? `📋 *Çeklist:* ${questionCount} sual\n` : '';

  const messageText =
    `📌 *${escapeMarkdown(task.title)}*\n\n` +
    `⚡ *Prioritet:* ${priorityLabel}\n` +
    `⏰ *Son tarix:* ${deadlineStr}\n` +
    checklistLine +
    `\n📝 *Təlimat:*\n${escapeMarkdown(task.description ?? '')}`;

  const keyboard = new InlineKeyboard().text(
    '📸 Rəf Şəklini Göndər',
    encodeCallback('open', task.id),
  );

  // If task has reference planogram image, send photo with caption
  if (task.reference_image_url) {
    try {
      await ctx.replyWithPhoto(task.reference_image_url, {
        caption: messageText,
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
      return;
    } catch {
      // If photo URL fails to load, fall back to text message
    }
  }

  await ctx.reply(messageText, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
}

/**
 * Opens a task and starts the guided flow.
 *
 * IDEMPOTENT BY CONSTRUCTION, NOT BY A TIMESTAMP
 * ----------------------------------------------
 * A duplicate tap arrives as a second update with the same `callback_data`, and
 * nothing in the data distinguishes it from a deliberate second tap. So this
 * does not try to guess: if the flow for this task is already running, the
 * current step's prompt is simply sent again and the state is left alone.
 *
 * The reading that would be wrong — "a second tap means start over" — is not
 * available here, because starting over throws away answers. That reading lives
 * behind its own button (`restart:<taskId>`), which says what it does.
 *
 * The one case where state *is* cleared is opening a task while a different
 * task's flow is running, and that is a real switch rather than a repeat. It
 * still says so out loud when answers would be lost, because silently discarding
 * a merchandiser's work is the failure this bot is meant to avoid.
 */
export async function handleOpenTask(
  ctx: BotContext,
  taskId: string,
  answer: AnswerCallback,
): Promise<void> {
  if (ctx.session.activeTaskId === taskId && ctx.session.step && ctx.session.step !== 'idle') {
    await answer();
    await resumeCurrentStep(ctx);
    return;
  }

  let task;
  try {
    task = await portalApi.getTaskById(taskId);
  } catch (error) {
    const detail = error instanceof PortalApiError ? error.message : String(error);
    console.error(`[oneTeam Bot] Task fetch failed for ${taskId}:`, detail);
    await answer('Tapşırıq yüklənmədi, yenidən cəhd edin.');
    return;
  }

  if (!task) {
    await answer('Tapşırıq tapılmadı!');
    return;
  }

  const answered = ctx.session.checklistAnswers?.length ?? 0;
  const switchingFromAnotherTask =
    Boolean(ctx.session.activeTaskId) && ctx.session.activeTaskId !== taskId;

  await answer();

  // Claim the store's open work for this chat before touching the task.
  //
  // WHY THIS IS HERE AND NOT ONLY AT /start
  // ---------------------------------------
  // "The store code is the claim": binding to a store assigns that store's
  // unassigned open tasks to whoever sent the code (see `FieldService.bind` →
  // `claimStoreTasks`). But that claim runs once, at bind time. A task a
  // supervisor publishes in the panel AFTER the merchandiser bound is never
  // claimed, so its `assignedUserId` stays empty — and `canUserAccessTask` then
  // refuses both the acknowledge below and the eventual photo submission with
  // `403 Bu tapşırıq üçün icazə yoxdur`. The task-open button opens the card and
  // then quietly fails to file anything: the exact IPHONE_TEST symptom seen in
  // the production logs as repeated 403s on `task-panel-…`.
  //
  // Re-binding for the session's store closes that temporal gap. It is
  // idempotent, it only ever claims unassigned open work at the store this chat
  // is already bound to, and a failure is non-fatal — the acknowledge below will
  // surface any real permission problem, and the merchandiser is not blocked
  // from trying. It is skipped when no store is bound, so it can never claim on
  // behalf of a chat that has not proven store presence.
  if (ctx.session.storeId) {
    try {
      const from = ctx.from;
      const fullName =
        [from?.first_name, from?.last_name].filter(Boolean).join(' ') || 'Merchandiser';
      await portalApi.bindTelegramUser({
        telegramChatId: ctx.chat!.id,
        fullName,
        username: from?.username,
        storeId: ctx.session.storeId,
      });
    } catch (error) {
      const detail = error instanceof PortalApiError ? error.message : String(error);
      console.error(`[oneTeam Bot] Re-claim on open failed for ${task.id}:`, detail);
    }
  }

  // Opening the task is the chat's equivalent of tapping "Acknowledge" on the
  // notification. The lifecycle only lets a supervisor review a SUBMITTED task,
  // and only an ACKNOWLEDGED task can become SUBMITTED — so skipping this would
  // leave the merchandiser's photo permanently unapprovable.
  //
  // A failure here is logged and the flow continues: the merchandiser can still
  // send the photo, and a supervisor can move the task on manually.
  try {
    const ack = await portalApi.acknowledgeTask(task.id, ctx.chat!.id);
    if (ack.advanced) {
      console.log(`[oneTeam Bot] Task ${task.id} -> ${ack.currentState} (acknowledged by chat)`);
    }
  } catch (error) {
    const detail = error instanceof PortalApiError ? error.message : String(error);
    console.error(`[oneTeam Bot] Acknowledge failed for ${task.id}:`, detail);
  }

  ctx.session.activeTaskId = task.id;
  ctx.session.activeTaskTitle = task.title;

  if (switchingFromAnotherTask && answered > 0) {
    await ctx.reply(
      `⚠️ *Diqqət:* əvvəlki tapşırıq üçün verdiyiniz *${answered}* cavab silindi, ` +
        `çünki yeni tapşırıq açdınız.`,
      { parse_mode: 'Markdown' },
    );
  }

  await ctx.reply(`📌 *Seçilmiş tapşırıq:* ${escapeMarkdown(task.title)}`, {
    parse_mode: 'Markdown',
  });

  // Straight into the guided flow: location, then checklist, then the photo.
  // The old behaviour — jumping to "send a photo" — is what produced submissions
  // with no location and no answers.
  //
  // The template's questions are handed over here rather than stored on the
  // session beforehand: the flow clears the session as it starts, and setting
  // them first would mean the clear wiped them.
  await beginTaskFlow(ctx, task.checklist_schema ?? []);
}
