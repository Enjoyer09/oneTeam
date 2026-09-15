import { InlineKeyboard } from 'grammy';
import { AnswerCallback, BotContext, TaskRecord } from '../types';
import { portalApi, PortalApiError } from '../../services/portalApi';
import { encodeCallback } from '../callbacks';
import { mainMenuInline } from '../keyboards';
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
      `ℹ️ *${ctx.session.storeName}* mağazası üçün hazırda aktiv rəf tapşırığı yoxdur.`,
      { parse_mode: 'Markdown', reply_markup: mainMenuInline() },
    );
    return;
  }

  await ctx.reply(`📋 *${ctx.session.storeName}* üçün aktiv tapşırıqlar (${tasks.length}):`, {
    parse_mode: 'Markdown',
  });

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
    `📌 *${task.title}*\n\n` +
    `⚡ *Prioritet:* ${priorityLabel}\n` +
    `⏰ *Son tarix:* ${deadlineStr}\n` +
    checklistLine +
    `\n📝 *Təlimat:*\n${task.description}`;

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

  await ctx.reply(`📌 *Seçilmiş tapşırıq:* ${task.title}`, { parse_mode: 'Markdown' });

  // Straight into the guided flow: location, then checklist, then the photo.
  // The old behaviour — jumping to "send a photo" — is what produced submissions
  // with no location and no answers.
  //
  // The template's questions are handed over here rather than stored on the
  // session beforehand: the flow clears the session as it starts, and setting
  // them first would mean the clear wiped them.
  await beginTaskFlow(ctx, task.checklist_schema ?? []);
}
