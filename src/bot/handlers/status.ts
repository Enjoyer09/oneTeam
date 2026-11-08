import { BotContext } from '../types';
import { portalApi, PortalApiError } from '../../services/portalApi';
import { mainMenuKeyboard } from '../keyboards';
import { escapeMarkdown } from '../markdown';
import { InlineKeyboard } from 'grammy';
import { encodeCallback } from '../callbacks';

/**
 * `/mystatus`, and the "📊 Statusum" button.
 *
 * Every reply carries the reply keyboard, because Phase 2.4's text path has to
 * be a way back to the buttons: the location step dismisses the reply keyboard
 * (`oneTime()`), and this command is one a merchandiser reaches for when they
 * are unsure whether anything was sent — exactly the moment they are most
 * likely to have lost the menu.
 */
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
      { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() },
    );
    return;
  }

  if (submissions.length === 0) {
    await ctx.reply(
      `ℹ️ *Hələ heç bir rəf fotosu göndərilməyib.*\n\n` +
        `Aktiv tapşırıqlara baxmaq və foto göndərmək üçün aşağıdaki *📋 Tapşırıqlar* düyməsindən istifadə edin.`,
      { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() },
    );
    return;
  }

  let statusText = `📊 *Son Göndərilən Auditlər (${submissions.length}):*\n\n`;

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

    statusText += `${i + 1}. *${escapeMarkdown(taskTitle)}*\n`;
    statusText += `   🏪 ${escapeMarkdown(storeName)}\n`;
    statusText += `   🕒 ${dateStr}\n`;
    statusText += `   📌 *Status:* ${statusLabel}\n`;

    if (sub.reviewer_feedback) {
      statusText += `   💬 *Supervayzer rəyi:* _"${escapeMarkdown(sub.reviewer_feedback)}"_\n`;
    }

    // Only http(s) photos can be linked.
    //
    // There is no object store yet, so a chat submission's photo is stored as an
    // inline `data:` URL — tens of kilobytes of base64. Rendering that as a
    // Markdown link would push the whole image into the message body and produce
    // a link Telegram cannot open. The photo is visible to the supervisor in the
    // panel, which is where a review happens anyway.
    // Only http(s) photos can be linked, and only when the URL is link-shaped:
    // a `)` or whitespace inside a Markdown link URL breaks the whole message,
    // and the URL is not bot-authored. The photo stays visible to the supervisor
    // in the panel either way.
    if (sub.photo_url && /^https?:\/\/[^\s()]+$/i.test(sub.photo_url)) {
      statusText += `   🖼 [Fotoşəkilə bax](${sub.photo_url})\n`;
    }

    statusText += `\n`;
  }

  await ctx.reply(statusText, {
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true },
    reply_markup: mainMenuKeyboard(),
  });

  for (const sub of submissions.filter((item) => item.status === 'rejected' && item.task_id)) {
    const keyboard = new InlineKeyboard().text('Düzəliş et', encodeCallback('open', sub.task_id));
    await ctx.reply(
      `❌ *${escapeMarkdown(sub.task?.title || 'Rəf yoxlanışı')}* üçün düzəliş tələb olunur.` +
        (sub.reviewer_feedback ? `\n\n📝 Səbəb: ${escapeMarkdown(sub.reviewer_feedback)}` : '') +
        `\n\nTapşırığı açıb yenilənmiş foto göndərin.`,
      { parse_mode: 'Markdown', reply_markup: keyboard },
    );
  }
}
