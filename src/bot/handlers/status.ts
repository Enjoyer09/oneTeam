import { BotContext } from '../types';
import { supabaseService } from '../../services/supabase';

export async function handleMyStatus(ctx: BotContext) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const submissions = await supabaseService.getSubmissionsByChatId(chatId, 5);

  if (submissions.length === 0) {
    await ctx.reply(
      `ℹ️ *Hələ heç bir rəf fotosu göndərilməyib.*\n\n` +
        `Aktiv tapşırıqlara baxmaq və foto göndərmək üçün /tasks əmrindən istifadə edin.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  let statusText = `📊 *Son Göndərilən Rəf Yoxlamaları (${submissions.length}):*\n\n`;

  const statusIcons: Record<string, string> = {
    pending_review: '⏳ Yoxlama gözləyir',
    approved: '✅ Təsdiqləndi',
    rejected: '❌ İmtina edildi',
  };

  for (let i = 0; i < submissions.length; i++) {
    const sub = submissions[i];
    const statusLabel = statusIcons[sub.status] || sub.status;
    const taskTitle = sub.task?.title || 'Rəf Yoxlanışı';
    const storeName = sub.store?.name || ctx.session.storeName || 'Mağaza';
    const dateStr = new Date(sub.submitted_at).toLocaleString('az-AZ', {
      timeZone: 'Asia/Baku',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    statusText += `${i + 1}. *${taskTitle}*\n`;
    statusText += `   🏪 ${storeName}\n`;
    statusText += `   🕒 ${dateStr}\n`;
    statusText += `   📌 *Status:* ${statusLabel}\n`;

    if (sub.reviewer_feedback) {
      statusText += `   💬 *Supervayzer rəyi:* _"${sub.reviewer_feedback}"_\n`;
    }

    if (sub.photo_url) {
      statusText += `   🖼 [Fotoşəkilə bax](${sub.photo_url})\n`;
    }

    statusText += `\n`;
  }

  await ctx.reply(statusText, {
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true },
  });
}
