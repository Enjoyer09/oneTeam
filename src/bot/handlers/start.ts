import { BotContext, AnswerCallback } from '../types';
import { portalApi, PortalApiError } from '../../services/portalApi';
import { mainMenuKeyboard } from '../keyboards';
import { escapeMarkdown } from '../markdown';
import { handleMenuHome } from './help';
import { handleOpenTask } from './tasks';

/**
 * A deep-link payload that opens a task directly.
 *
 * Telegram delivers `t.me/<bot>?start=<payload>` as `/start <payload>`, and
 * grammy hands the payload to a command handler as `ctx.match`. A supervisor (or
 * the panel) can therefore hand a merchandiser a link that drops them straight
 * into a task's guided flow instead of "open the bot, tap Tasks, find it, tap
 * it". The payload we mint is `task_<storeTaskId>`; anything else is treated as a
 * plain `/start`.
 *
 * The store-task id is a UUID, so `task_` + 36 chars is well under Telegram's
 * 64-byte start-payload limit.
 */
const DEEP_LINK_TASK_PREFIX = 'task_';

/**
 * Store-code guess throttling.
 *
 * A store code is the whole claim here: presenting a valid one binds the chat
 * to that store's open work (see `FieldService.bind`). The API-side enrolment
 * limiter counts *successful* enrolments per address; wrong guesses are the
 * bot's to police, and unbounded guessing against the lookup endpoint is how a
 * code is found without ever tripping the API's limiter.
 *
 * In-memory on purpose: one polling process serves all chats, and a restart
 * merely forgets the counter — the cost of a wrong trade-off here is a
 * merchandiser being briefly told to wait, not a lost audit.
 */
const STORE_CODE_MAX_GUESSES = 5;
const STORE_CODE_WINDOW_MS = 10 * 60 * 1000;
const STORE_CODE_BLOCK_MS = 10 * 60 * 1000;
const storeCodeFailures = new Map<number, { at: number[]; blockedUntil: number }>();

function storeCodeGuessesBlocked(chatId: number): number {
  const entry = storeCodeFailures.get(chatId);
  if (!entry) return 0;
  const now = Date.now();
  if (entry.blockedUntil > now) return entry.blockedUntil - now;
  // A window that has fully expired is a fresh start, so the map cannot grow
  // one stale entry per chat that ever typed a wrong code.
  if (entry.at.every((at) => now - at > STORE_CODE_WINDOW_MS)) {
    storeCodeFailures.delete(chatId);
  }
  return 0;
}

function recordStoreCodeMiss(chatId: number): void {
  const now = Date.now();
  const entry = storeCodeFailures.get(chatId) ?? { at: [], blockedUntil: 0 };
  entry.at = entry.at.filter((at) => now - at <= STORE_CODE_WINDOW_MS);
  entry.at.push(now);
  if (entry.at.length >= STORE_CODE_MAX_GUESSES) {
    entry.blockedUntil = now + STORE_CODE_BLOCK_MS;
  }
  storeCodeFailures.set(chatId, entry);
}

/**
 * `/start` — enrolment, the home screen, or a deep-linked task.
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
  // A deep-link payload rides in on `ctx.match` for a command. `.trim()` because
  // some clients append a trailing space; the type guard because `ctx.match` is
  // only a string on a command update.
  const payload = typeof ctx.match === 'string' ? ctx.match.trim() : '';

  if (ctx.session.storeId) {
    // Enrolled. A `task_<id>` deep link means "take me into this task now"; any
    // other `/start` means "take me home".
    if (payload.startsWith(DEEP_LINK_TASK_PREFIX)) {
      const taskId = payload.slice(DEEP_LINK_TASK_PREFIX.length);
      if (taskId) {
        await openDeepLinkedTask(ctx, taskId);
        return;
      }
    }
    await handleMenuHome(ctx);
    return;
  }

  // Not enrolled. A deep link cannot open a task before a store is bound — the
  // task belongs to a store the bot does not yet know this chat works at — so
  // the code prompt is still the only thing that can help, and it is what they
  // get. (The payload is not stashed: persisting it would need a new session
  // field the API must also learn to store, and the merchandiser reaches their
  // tasks in one tap from the menu the moment they enrol.)
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
    `👋 *oneTeam — Rəf Yoxlama Sisteminə Xoş Gəlmisiniz!*\n\n` +
    `Platformadan istifadə etmək üçün zəhmət olmasa təmsil etdiyiniz *Mağaza Kodunu* göndərin.\n\n` +
    `💡 *Kodun formatı:* \`ŞƏBƏKƏ_FİLİAL_NÖMRƏ\` (məsələn şəbəkə adı, filial və sıra nömrəsi).\n` +
    `Dəqiq mağaza kodunuzu sizə mağazanı təyin edən *nəzarətçiniz* verir.`;

  // No keyboard on purpose: at this point the only useful action is to type a
  // store code, and a "📋 Tapşırıqlar" button that answers "no store
  // registration" teaches a new user that the buttons here do not work.
  await ctx.reply(welcomeMessage, { parse_mode: 'Markdown' });
}

/**
 * Opens a task reached through a `task_<id>` deep link.
 *
 * The real work — fetch, acknowledge, start the guided flow — is `handleOpenTask`,
 * which was written for a button tap and so speaks to the merchandiser through
 * the callback answerer (a toast). There is no callback query behind a `/start`,
 * so this passes an answerer that turns those toasts into chat replies: a
 * successful open calls `answer()` with no text and stays silent (the flow's own
 * messages take over), while "Tapşırıq tapılmadı!" and the like become a visible
 * message instead of vanishing. That is what keeps a stale or wrong link from
 * reading as the bot ignoring the tap.
 */
async function openDeepLinkedTask(ctx: BotContext, taskId: string): Promise<void> {
  const replyAnswer: AnswerCallback = async (toast?: string) => {
    if (toast) {
      await ctx.reply(`ℹ️ ${toast}`, { reply_markup: mainMenuKeyboard() });
    }
  };
  await handleOpenTask(ctx, taskId, replyAnswer);
}

/**
 * The chat this update belongs to, or a thrown error.
 *
 * Every handler here is routed only for a chat update, and each one addresses
 * the chat on its first API call — so a missing chat is not a case to handle,
 * it is a wiring mistake. Stating that once is what lets the calls below use a
 * plain number instead of a `!` on every line.
 */
function requireChatId(ctx: BotContext): number {
  if (!ctx.chat) {
    throw new Error('Bot handler reached without a chat — the router only routes chat updates.');
  }
  return ctx.chat.id;
}

export async function handleStoreCodeInput(ctx: BotContext) {
  const chatId = requireChatId(ctx);

  const blockedFor = storeCodeGuessesBlocked(chatId);
  if (blockedFor > 0) {
    await ctx.reply(
      `⏳ Çoxlu yanlış mağaza kodu daxil etmisiniz. Təxminən *${Math.ceil(blockedFor / 60000)}* dəqiqə ` +
        `gözləyin və sonra yenidən cəhd edin, və ya kodu nəzarətçinizdən dəqiqləşdirin.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

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
    recordStoreCodeMiss(chatId);
    // `text` is whatever the chat typed, not a code the router pre-filtered —
    // the `awaiting_store_code` branch of `handleTextRoute` forwards every text.
    // Inside a code span an escaping backslash would render literally, so the
    // raw text is escaped as plain Markdown instead.
    await ctx.reply(
      `❌ *Mağaza kodu tapılmadı:* ${escapeMarkdown(text)}\n\n` +
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
      telegramChatId: chatId,
      fullName,
      username: user?.username,
      storeId: store.id,
    });
  } catch (error) {
    const detail = error instanceof PortalApiError ? error.message : String(error);
    console.error(`[oneTeam Bot] Bind failed for chat ${chatId}:`, detail);
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
  storeCodeFailures.delete(chatId);

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
    `🏪 *Mağaza:* ${escapeMarkdown(store.name)}\n` +
    `🏷 *Kod:* \`${store.store_code}\`\n` +
    `📍 *Ünvan:* ${escapeMarkdown(store.address || store.city || '')}\n` +
    `👤 *Təmsilçi:* ${escapeMarkdown(fullName)}\n` +
    claimLine +
    `\nRəf tapşırıqlarını görmək üçün aşağıdakı menyudan *📋 Tapşırıqlar* seçin və ya /tasks yazın.`;

  await ctx.reply(successMessage, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
}
