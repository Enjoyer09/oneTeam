/**
 * oneTeam Telegram Bot — help and the main menu
 * ============================================================================
 *
 * Phase 2's goal is that a field worker types no command at all. That makes this
 * file load-bearing rather than decorative: it is what a merchandiser gets when
 * they send a message the bot did not expect, and it has to answer the question
 * they actually have — "what am I supposed to do here?" — without a list of
 * slash commands as the headline.
 *
 * So the commands are listed last and described as optional, and the six steps
 * of the flow come first. The buttons that do the same thing are attached to
 * every copy of it, which is what Phase 2.4 requires: the text path has to work
 * when inline is unavailable, and the button path has to work when nobody has
 * read the text.
 */

import { BotContext } from '../types';
import { mainMenuInline } from '../keyboards';

/** The six steps, in the order the flow runs them. */
const FLOW_SUMMARY =
  `*Necə işləyir — 6 addım:*\n` +
  `1️⃣ 📋 *Tapşırıqlar* düyməsinə basın\n` +
  `2️⃣ Mağazanız üçün tapşırığı seçin\n` +
  `3️⃣ 📍 Lokasiyanızı paylaşın\n` +
  `4️⃣ 📋 Çeklist suallarını cavablandırın\n` +
  `5️⃣ 📸 Rəfin fotosunu göndərin\n` +
  `6️⃣ ✅ Şəkli təsdiqləyin — o zaman göndərilir\n\n` +
  `Heç bir əmr yazmaq lazım deyil.`;

export async function handleHelp(ctx: BotContext): Promise<void> {
  await ctx.reply(
    `🤖 *oneTeam Köməkçi*\n\n` +
      `Bu bot rəf və soyuducu yoxlamalarını nəzarətçiyə göndərmək üçündür.\n\n` +
      FLOW_SUMMARY +
      `\n\n*Əmrlər (könüllü):*\n` +
      `• /tasks — aktiv tapşırıqlar\n` +
      `• /mystatus — son göndərdiyiniz şəkillərin statusu\n` +
      `• /start — mağazanı dəyişmək\n` +
      `• /help — bu mesaj`,
    { parse_mode: 'Markdown', reply_markup: mainMenuInline() },
  );
}

/**
 * The main menu, as a message.
 *
 * Deliberately shorter than `/help`: this is reached by tapping a button, which
 * means the person is already looking at the buttons, and repeating the whole
 * six-step list under them would push the buttons off the screen.
 */
export async function handleMenuHome(ctx: BotContext): Promise<void> {
  const where = ctx.session.storeName
    ? `🏪 *${ctx.session.storeName}*`
    : `🏪 Mağaza seçilməyib — /start ilə mağaza kodunuzu daxil edin.`;

  const inProgress = ctx.session.activeTaskTitle
    ? `\n\n⏳ *Davam edən iş:* ${ctx.session.activeTaskTitle}`
    : '';

  await ctx.reply(`${where}${inProgress}\n\nNə etmək istəyirsiniz?`, {
    parse_mode: 'Markdown',
    reply_markup: mainMenuInline(),
  });
}
