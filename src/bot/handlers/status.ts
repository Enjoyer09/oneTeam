import { BotContext } from '../types';
import { portalApi, PortalApiError } from '../../services/portalApi';

export async function handleMyStatus(ctx: BotContext) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  let submissions;
  try {
    submissions = await portalApi.getSubmissionsByChatId(chatId, 5);
  } catch (error) {
    const detail = error instanceof PortalApiError ? error.message : String(error);
    console.error(`[oneTeam Bot] Status lookup failed for chat ${chatId}:`, detail);
    await ctx.reply(
      `❌ *Status məlumatını yükləmək mümkün olmadı.*\n\nZəhmət olmasa bir az sonra yenidən cəhd edin.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  if (submissions.length === 0) {
    await ctx.reply(
      `ℹ️ *Hələ heç bir rəf fotosu göndərilməyib.*\n\n` +
        `Aktiv tapşırıqlara baxmaq və foto göndərmək üçün /tasks əmrindən istifadə edin.`,
      { parse_mode: 'Markdown' },
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

    // Only http(s) photos can be linked.
    //
    // There is no object store yet, so a chat submission's photo is stored as an
    // inline `data:` URL — tens of kilobytes of base64. Rendering that as a
    // Markdown link would push the whole image into the message body and produce
    // a link Telegram cannot open. The photo is visible to the supervisor in the
    // panel, which is where a review happens anyway.
    if (sub.photo_url && /^https?:\/\//i.test(sub.photo_url)) {
      statusText += `   🖼 [Fotoşəkilə bax](${sub.photo_url})\n`;
    }

    statusText += `\n`;
  }

  await ctx.reply(statusText, {
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true },
  });
}
