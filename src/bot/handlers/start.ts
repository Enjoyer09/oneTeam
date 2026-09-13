import { Keyboard } from 'grammy';
import { BotContext } from '../types';
import { portalApi, PortalApiError } from '../../services/portalApi';

export async function handleStart(ctx: BotContext) {
  ctx.session.step = 'awaiting_store_code';

  // The examples are real store codes from the seeded catalogue. A made-up one
  // is worse than none: a merchandiser who types the example and is told the
  // store does not exist has been sent to a dead end by the bot itself.
  const welcomeMessage =
    `👋 *oneTeam — Rəf Monitorinq Sisteminə Xoş Gəlmisiniz!* (Coca-Cola FMCG)\n\n` +
    `Platformadan istifadə etmək üçün zəhmət olmasa təmsil etdiyiniz *Mağaza Kodunu* göndərin.\n\n` +
    `💡 *Nümunə:* \`BRAVO_YASAMAL_01\` və ya \`ARAZ_GENJLIK_02\``;

  await ctx.reply(welcomeMessage, { parse_mode: 'Markdown' });
}

export async function handleStoreCodeInput(ctx: BotContext) {
  const text = ctx.message?.text?.trim();
  if (!text) return;

  let store;
  try {
    store = await portalApi.validateAndGetStore(text);
  } catch (error) {
    // A merchandiser standing in a shop cannot do anything about a backend
    // problem, so the reply says what happened and who to tell — not a stack
    // trace they would have to interpret.
    const detail = error instanceof PortalApiError ? error.message : String(error);
    console.error(`[oneTeam Bot] Store lookup failed for "${text}":`, detail);
    await ctx.reply(
      `❌ *Sistemə qoşulmaq mümkün olmadı.*\n\n` +
        `Mağaza kodunuzu yoxlamaq alınmadı. Zəhmət olmasa bir az sonra yenidən cəhd edin ` +
        `və ya problem davam edərsə nəzarətçinizə məlumat verin.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (!store) {
    await ctx.reply(
      `❌ *Mağaza kodu tapılmadı:* \`${text}\`\n\n` +
        `Zəhmət olmasa, mağaza kodunun düzgünlüyünü yoxlayın və yenidən daxil edin (Məsələn: \`BRAVO_YASAMAL_01\`).`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Bind Telegram user to profile, and claim this store's open work in the same
  // call — see portalApi.bindTelegramUser for why the claim is required.
  const user = ctx.from;
  const fullName = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'Merchandiser';

  let profile;
  try {
    profile = await portalApi.bindTelegramUser({
      telegramChatId: ctx.chat!.id,
      fullName,
      username: user?.username,
      storeId: store.id,
    });
  } catch (error) {
    const detail = error instanceof PortalApiError ? error.message : String(error);
    console.error(`[oneTeam Bot] Bind failed for chat ${ctx.chat?.id}:`, detail);
    await ctx.reply(
      `❌ *Qeydiyyat tamamlanmadı.*\n\nMağaza tapıldı, amma hesabınız bağlana bilmədi. ` +
        `Zəhmət olmasa bir az sonra yenidən cəhd edin.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Save in session
  ctx.session.storeId = store.id;
  ctx.session.storeCode = store.store_code;
  ctx.session.storeName = store.name;
  ctx.session.profileId = profile.id;
  ctx.session.step = 'idle';

  const keyboard = new Keyboard().text('📋 Tapşırıqlar').text('📊 Statusum').resized();

  // Saying how many tasks were claimed is the difference between "the bot
  // accepted me" and "there is work waiting for me", which is what the
  // merchandiser actually wants to know.
  const claimLine =
    profile.claimedTaskIds.length > 0
      ? `\n📌 *Sizə təyin edildi:* ${profile.claimedTaskIds.length} tapşırıq\n`
      : '';

  const successMessage =
    `✅ *Mağaza uğurla təsdiqləndi!*\n\n` +
    `🏪 *Mağaza:* ${store.name}\n` +
    `🏷 *Kod:* \`${store.store_code}\`\n` +
    `📍 *Ünvan:* ${store.address || store.city}\n` +
    `👤 *Təmsilçi:* ${fullName}\n` +
    claimLine +
    `\nPlanogram və rəf tapşırıqlarını görmək üçün aşağıdakı menyudan *📋 Tapşırıqlar* seçin və ya /tasks yazın.`;

  await ctx.reply(successMessage, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
}
