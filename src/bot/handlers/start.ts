import { BotContext } from '../types';
import { portalApi, PortalApiError } from '../../services/portalApi';
import { mainMenuKeyboard } from '../keyboards';
import { handleMenuHome } from './help';

/**
 * `/start` — enrolment, or the home screen.
 *
 * `/start` IS NOT ALWAYS A NEW USER
 * ---------------------------------
 * It is the most-typed command in Telegram: the client sends it when the chat
 * is opened from the chat list, the "START" button sends it, and people type it
 * when they are lost. Before Phase 2.4 this handler answered every one of those
 * with the store-code prompt and wrote `step = 'awaiting_store_code'` — so a
 * merchandiser who was already enrolled and half way through a checklist who
 * typed `/start` was asked for a code the bot already had, and their running
 * flow was derailed. Nothing was lost (the store binding lives in the session),
 * but the bot looked like it had forgotten them.
 *
 * So the question this handler asks is not "what did they type?" but "is this
 * chat enrolled?". If it is, `/start` means "take me home" and that is what it
 * does — the same screen the `🏠 Menyu` button produces. If it is not, the code
 * prompt is the only thing that can help and it is what they get.
 */
export async function handleStart(ctx: BotContext) {
  if (ctx.session.storeId) {
    await handleMenuHome(ctx);
    return;
  }

  ctx.session.step = 'awaiting_store_code';

  // The prompt shows the *shape* of a code, never a working one.
  //
  // In this system the store code is not a hint, it is the claim: binding to a
  // store assigns that store's open work to whoever sent the code (see
  // `FieldService.bind`). Printing a real, live code here — as this once did —
  // hands a working enrolment credential to anyone who opens the bot, which is
  // the opposite of what a claim credential is for.
  //
  // A made-up code that *looks* typeable is the other trap: a merchandiser who
  // types it is told the store does not exist and has been sent to a dead end.
  // So the example is a labelled format (CHAIN_BRANCH_NUMBER), clearly a
  // template rather than something to type, and the real code comes from the
  // supervisor who assigned the store — not from the bot.
  const welcomeMessage =
    `👋 *oneTeam — Rəf Monitorinq Sisteminə Xoş Gəlmisiniz!* (Coca-Cola FMCG)\n\n` +
    `Platformadan istifadə etmək üçün zəhmət olmasa təmsil etdiyiniz *Mağaza Kodunu* göndərin.\n\n` +
    `💡 *Kodun formatı:* \`ŞƏBƏKƏ_FİLİAL_NÖMRƏ\` (məsələn şəbəkə adı, filial və sıra nömrəsi).\n` +
    `Dəqiq mağaza kodunuzu sizə mağazanı təyin edən *nəzarətçiniz* verir.`;

  // No keyboard on purpose: at this point the only useful action is to type a
  // store code, and a "📋 Tapşırıqlar" button that answers "no store
  // registration" teaches a new user that the buttons here do not work.
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
      { parse_mode: 'Markdown' },
    );
    return;
  }

  if (!store) {
    await ctx.reply(
      `❌ *Mağaza kodu tapılmadı:* \`${text}\`\n\n` +
        `Zəhmət olmasa, mağaza kodunun düzgünlüyünü yoxlayın və yenidən daxil edin. ` +
        `Kodu bilmirsinizsə, sizə mağazanı təyin edən nəzarətçinizlə əlaqə saxlayın.`,
      { parse_mode: 'Markdown' },
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
      { parse_mode: 'Markdown' },
    );
    return;
  }

  // Save in session
  ctx.session.storeId = store.id;
  ctx.session.storeCode = store.store_code;
  ctx.session.storeName = store.name;
  ctx.session.profileId = profile.id;
  ctx.session.step = 'idle';

  const keyboard = mainMenuKeyboard();

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
