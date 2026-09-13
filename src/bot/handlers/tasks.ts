import { InlineKeyboard } from 'grammy';
import { BotContext } from '../types';
import { supabaseService } from '../../services/supabase';

export async function handleTasks(ctx: BotContext) {
  if (!ctx.session.storeId) {
    await ctx.reply(
      `⚠️ *Mağaza qeydiyyatı tapılmadı!*\n\nZəhmət olmasa əvvəlcə /start əmrini göndərib mağaza kodunuzu daxil edin.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const tasks = await supabaseService.getTasksForStore(ctx.session.storeId);

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

export async function sendTaskDetails(ctx: BotContext, task: any) {
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
  const task = await supabaseService.getTaskById(taskId);

  if (!task) {
    await ctx.answerCallbackQuery({ text: 'Tapşırıq tapılmadı!' });
    return;
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
