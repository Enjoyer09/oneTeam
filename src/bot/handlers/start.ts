import { InlineKeyboard, Keyboard } from 'grammy';
import { BotContext } from '../types';
import { supabaseService } from '../../services/supabase';

export async function handleStart(ctx: BotContext) {
  ctx.session.step = 'awaiting_store_code';

  const welcomeMessage =
    `👋 *oneTeam — Rəf Monitorinq Sisteminə Xoş Gəlmisiniz!* (Coca-Cola FMCG)\n\n` +
    `Platformadan istifadə etmək üçün zəhmət olmasa təmsil etdiyiniz *Mağaza Kodunu* göndərin.\n\n` +
    `💡 *Nümunə:* \`BRAVO_28MAY_01\` və ya \`ARAZ_GENJLIK_02\``;

  await ctx.reply(welcomeMessage, { parse_mode: 'Markdown' });
}

export async function handleStoreCodeInput(ctx: BotContext) {
  const text = ctx.message?.text?.trim();
  if (!text) return;

  const store = await supabaseService.validateAndGetStore(text);

  if (!store) {
    await ctx.reply(
      `❌ *Mağaza kodu tapılmadı:* \`${text}\`\n\n` +
        `Zəhmət olmasa, mağaza kodunun düzgünlüyünü yoxlayın və yenidən daxil edin (Məsələn: \`BRAVO_28MAY_01\`).`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Bind Telegram user to profile
  const user = ctx.from;
  const fullName = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'Merchandiser';
  const profile = await supabaseService.bindTelegramUser({
    telegramChatId: ctx.chat!.id,
    fullName,
    username: user?.username,
  });

  // Save in session
  ctx.session.storeId = store.id;
  ctx.session.storeCode = store.store_code;
  ctx.session.storeName = store.name;
  ctx.session.profileId = profile.id;
  ctx.session.step = 'idle';

  const keyboard = new Keyboard()
    .text('📋 Tapşırıqlar')
    .text('📊 Statusum')
    .resized();

  const successMessage =
    `✅ *Mağaza uğurla təsdiqləndi!*\n\n` +
    `🏪 *Mağaza:* ${store.name}\n` +
    `🏷 *Kod:* \`${store.store_code}\`\n` +
    `📍 *Ünvan:* ${store.address || store.city}\n` +
    `👤 *Təmsilçi:* ${fullName}\n\n` +
    `Planogram və rəf tapşırıqlarını görmək üçün aşağıdakı menyudan *📋 Tapşırıqlar* seçin və ya /tasks yazın.`;

  await ctx.reply(successMessage, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
}
