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
 * of the flow come first.
 *
 * WHY THESE REPLIES CARRY THE REPLY KEYBOARD AND NOT THE INLINE ONE
 * -----------------------------------------------------------------
 * Phase 2.4 asks for the text path to work when inline is unavailable, and this
 * is where that is decided. A message carries one `reply_markup` — never both —
 * so the choice is real, and for a message that answers a typed command the
 * reply keyboard is the one that helps:
 *
 *   - It persists. The inline buttons die with their message the moment the
 *     chat scrolls.
 *   - It is the ONLY kind that can be brought back by typing. The location step
 *     sends `locationRequestKeyboard()`, which is `oneTime()`, so using it
 *     dismisses the reply keyboard and nothing in the flow puts it back. Before
 *     2.4, a merchandiser who had shared a location and scrolled past the
 *     checklist had no buttons at all, and `/help` did not give them any.
 *
 * The inline menu still exists and is still sent — from `resumeCurrentStep`,
 * where it answers a button tap and the buttons belong next to the question.
 */

import { BotContext } from '../types';
import { mainMenuKeyboard } from '../keyboards';

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

/**
 * `/help`, and the answer to any text the bot did not expect.
 *
 * The reply keyboard is attached here rather than an inline one, and that is
 * the whole of Phase 2.4: this message is the way back. A merchandiser who has
 * lost the buttons — which the location step's `oneTime()` keyboard does on
 * purpose — gets them back by typing anything at all, or by tapping "❓ Kömək".
 */
export async function handleHelp(ctx: BotContext): Promise<void> {
  await ctx.reply(
    `🤖 *oneTeam Köməkçi*\n\n` +
      `Bu bot rəf və soyuducu yoxlamalarını nəzarətçiyə göndərmək üçündür.\n\n` +
      FLOW_SUMMARY +
      `\n\n⬇️ *Menyu* mesaj qutusunun altındadır — istənilən vaxt oradan davam edə bilərsiniz.\n\n` +
      `*Əmrlər (könüllü):*\n` +
      `• /tasks — aktiv tapşırıqlar\n` +
      `• /mystatus — son göndərdiyiniz şəkillərin statusu\n` +
      `• /start — mağazanı dəyişmək\n` +
      `• /help — bu mesaj`,
    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() },
  );
}

/**
 * The main menu, as a message.
 *
 * Deliberately shorter than `/help`: this is reached by tapping a button or by
 * typing `/start`, and in both cases the person wants to know where they are
 * and what they can do — not to read the flow explained again.
 *
 * It is also what `/start` answers once a chat is enrolled. See `handleStart`
 * for why that matters.
 */
export async function handleMenuHome(ctx: BotContext): Promise<void> {
  const where = ctx.session.storeName
    ? `🏪 *${ctx.session.storeName}*`
    : `🏪 Mağaza seçilməyib — /start ilə mağaza kodunuzu daxil edin.`;

  // How to switch stores has to be said somewhere, and this is the only screen
  // that knows a store is bound. There is deliberately no `/store` command: the
  // code is typed, so the instruction is "type the code", which is one thing to
  // remember instead of two.
  const switchHint = ctx.session.storeName
    ? `\nBaşqa mağazaya keçmək üçün yeni mağaza kodunu yazıb göndərin.`
    : '';

  const inProgress = ctx.session.activeTaskTitle
    ? `\n\n⏳ *Davam edən iş:* ${ctx.session.activeTaskTitle}`
    : '';

  await ctx.reply(`${where}${switchHint}${inProgress}\n\nNə etmək istəyirsiniz?`, {
    parse_mode: 'Markdown',
    reply_markup: mainMenuKeyboard(),
  });
}
