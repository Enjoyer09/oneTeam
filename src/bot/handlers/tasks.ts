import { InlineKeyboard } from 'grammy';
import { BotContext, TaskRecord } from '../types';
import { portalApi, PortalApiError } from '../../services/portalApi';

export async function handleTasks(ctx: BotContext) {
  if (!ctx.session.storeId) {
    await ctx.reply(
      `⚠️ *Mağaza qeydiyyatı tapılmadı!*\n\nZəhmət olmasa əvvəlcə /start əmrini göndərib mağaza kodunuzu daxil edin.`,
      { parse_mode: 'Markdown' }
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
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (tasks.length === 0) {
    await ctx.reply(
      `ℹ️ *${ctx.session.storeName}* mağazası üçün hazırda aktiv rəf tapşırığı yoxdur.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await ctx.reply(
    `📋 *${ctx.session.storeName}* üçün aktiv tapşırıqlar (${tasks.length}):`,
    { parse_mode: 'Markdown' }
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

  const messageText =
    `📌 *${task.title}*\n\n` +
    `⚡ *Prioritet:* ${priorityLabel}\n` +
    `⏰ *Son tarix:* ${deadlineStr}\n\n` +
    `📝 *Təlimat:*\n${task.description}`;

  const keyboard = new InlineKeyboard().text(
    '📸 Rəf Şəklini Göndər',
    `submit_${task.id}`
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

export async function handleTaskSelectCallback(ctx: BotContext) {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('submit_')) return;

  const taskId = data.replace('submit_', '');

  let task;
  try {
    task = await portalApi.getTaskById(taskId);
  } catch (error) {
    const detail = error instanceof PortalApiError ? error.message : String(error);
    console.error(`[oneTeam Bot] Task fetch failed for ${taskId}:`, detail);
    await ctx.answerCallbackQuery({ text: 'Tapşırıq yüklənmədi, yenidən cəhd edin.' });
    return;
  }

  if (!task) {
    await ctx.answerCallbackQuery({ text: 'Tapşırıq tapılmadı!' });
    return;
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
  ctx.session.step = 'awaiting_photo';

  await ctx.answerCallbackQuery();

  await ctx.reply(
    `📸 *Seçilmiş Tapşırıq:* ${task.title}\n\n` +
      `Zəhmət olmasa indi yoxlanılan rəfin / soyuducunun aydın fotosunu çəkib bu çatda göndərin.\n\n` +
      `💡 *Məsləhət:* Bütün brend etiketlərinin və qiymət kağızlarının kadra düşdüyündən əmin olun.`,
    { parse_mode: 'Markdown' }
  );
}
