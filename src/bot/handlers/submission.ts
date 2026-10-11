/**
 * oneTeam Telegram Bot — the photo step
 * ============================================================================
 *
 * TWO PHASES, AND WHY THE SECOND ONE EXISTS
 * -----------------------------------------
 * A photo used to be filed the instant it arrived. Telegram compresses images,
 * a phone camera picks whatever it picks, and the merchandiser had no way to
 * see what the bot had actually received — so the first look at the evidence
 * was a supervisor's, in a review queue, hours later. A blurred or badly framed
 * shot then cost a rejection, a re-shoot and a second trip to the shelf.
 *
 * So the photo now arrives in two parts:
 *
 *   1. `handlePhotoArrival` — holds Telegram's `file_id` and shows the
 *      merchandiser the picture back, with two buttons.
 *   2. `handleConfirmPhoto` — files it, and only then.
 *
 * Only the `file_id` is held between the two. The bytes are not downloaded, no
 * `data:` URL is built and no row is written until the confirm tap, so a photo
 * that is thrown away costs nothing but the tap. Telegram keeps a file
 * addressable by its id, so the download at confirm time is the same download
 * that would have happened earlier.
 *
 * WHY THE GUARD IS THE WHOLE OF THE IDEMPOTENCY
 * ---------------------------------------------
 * A duplicate tap on "✅ Təsdiqlə" is a second update carrying the same
 * `callback_data`. It cannot be told apart from a deliberate second tap, so the
 * guard asks a different question: has the effect already happened? After a
 * successful confirm the session is back to `idle` with no `pendingPhoto`, so
 * the second tap finds nothing to file and says so. One audit, one receipt, no
 * error.
 *
 * That reasoning depends on two updates never being handled at the same time —
 * grammY handles them sequentially and writes the session between them. See the
 * header of `router.test.ts` for the two line references.
 *
 * A failed confirm deliberately leaves `pendingPhoto` in place, so the button
 * still works and the merchandiser retries instead of re-shooting.
 */

import { InlineKeyboard } from 'grammy';
import { AnswerCallback, BotContext } from '../types';
import { portalApi, PortalApiError } from '../../services/portalApi';
import { resolveVisionProvider, type VisionAnalysis } from '../../services/vision';
import { encodeCallback } from '../callbacks';
import { MENU_HOME_LABEL, mainMenuKeyboard } from '../keyboards';
import { escapeMarkdown } from '../markdown';

/**
 * Hard ceiling on the two Telegram calls that download a photo.
 *
 * grammY's `bot.start()` processes updates SEQUENTIALLY — one at a time, each
 * awaited before the next is read — so an unbounded network call here does not
 * just stall this one chat, it freezes the whole bot for every chat until the
 * socket eventually errors. `getFile` and the raw file download both reach
 * Telegram's CDN, which can hiccup or half-open a socket, so both are bounded.
 * 20s mirrors `REQUEST_TIMEOUT_MS` in services/portalApi.ts.
 */
const PHOTO_FETCH_TIMEOUT_MS = Number(process.env.ONETEAM_PHOTO_FETCH_TIMEOUT_MS) || 20_000;

/** What is held between the photo arriving and the merchandiser confirming it. */
type PendingPhoto = NonNullable<BotContext['session']['pendingPhoto']>;

export async function handlePhotoArrival(ctx: BotContext): Promise<void> {
  const storeId = ctx.session.storeId;
  if (!storeId) {
    await ctx.reply(
      `⚠️ *Əvvəlcə mağaza qeydiyyatından keçin!*\n\nZəhmət olmasa /start əmri ilə mağaza kodunuzu daxil edin.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const taskId = ctx.session.activeTaskId;

  // A photo with no task open. The photo is the LAST step of the guided flow, so
  // there is genuinely nothing to attach this one to yet — but rather than a dead
  // end, offer the store's own tasks right here so the merchandiser can select
  // one in a single tap instead of hunting through the menu.
  if (!taskId) {
    await promptTaskSelectionForPhoto(ctx, storeId);
    return;
  }

  // The photo is the LAST step of the guided flow, so a photo that arrives while
  // the chat is still waiting for a location or a checklist answer is a
  // merchandiser jumping ahead. Accepting it would file the same submission the
  // flow exists to prevent — no location, no answers — and silently skip a
  // control. Saying where they are costs one message and keeps the audit honest.
  if (ctx.session.step === 'awaiting_location' || ctx.session.step === 'awaiting_checklist') {
    const missing =
      ctx.session.step === 'awaiting_location'
        ? '📍 lokasiya paylaşmaq'
        : '📋 çeklist suallarını cavablandırmaq';

    await ctx.reply(
      `⚠️ *Şəkil hələ qəbul edilə bilməz.*\n\n` +
        `Əvvəlcə ${missing} lazımdır.\n\n` +
        `Zəhmət olmasa yuxarıdaki addımı tamamlayın — sonra şəkil göndərə bilərsiniz.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) {
    await ctx.reply(`❌ Fotoşəkil qəbul edilmədi. Zəhmət olmasa təkrar cəhd edin.`);
    return;
  }

  // Telegram returns photos ordered from smallest to largest; pick highest resolution
  const highestResPhoto = photos[photos.length - 1];

  // Sending another photo while one is already waiting replaces it. That is what
  // sending another photo means, and asking "which one did you want?" would be a
  // question the merchandiser cannot answer from the chat.
  const replacing = ctx.session.step === 'awaiting_confirm' && Boolean(ctx.session.pendingPhoto);

  ctx.session.pendingPhoto = {
    fileId: highestResPhoto.file_id,
    width: highestResPhoto.width,
    height: highestResPhoto.height,
    fileSize: highestResPhoto.file_size,
    messageId: ctx.message?.message_id,
  };
  ctx.session.step = 'awaiting_confirm';

  const answered = ctx.session.checklistAnswers?.length ?? 0;
  const checklistLine =
    answered > 0 ? `✅ Çeklist: ${answered} cavab\n` : `⚠️ Çeklist: cavabsız qeydə alınacaq\n`;
  const locationLine = ctx.session.location
    ? `✅ Lokasiya: təsdiqləndi\n`
    : `⚠️ Lokasiya: paylaşılmadı\n`;

  await ctx.replyWithPhoto(highestResPhoto.file_id, {
    caption:
      (replacing ? `🔄 *Şəkil dəyişdirildi.*\n\n` : `📸 *Şəkli yoxlayın.*\n\n`) +
      `📌 *${escapeMarkdown(ctx.session.activeTaskTitle ?? 'Tapşırıq')}*\n` +
      checklistLine +
      locationLine +
      `\nBu şəkil nəzarətçiyə göndəriləcək. Aydındırsa *✅ Təsdiqlə və göndər* düyməsinə basın.\n` +
      `Əgər bulanıqdır, brend etiketləri görünmür və ya yanlış rəfdirsə — *🔄 Yenidən çək* düyməsinə basın.\n\n` +
      `Təsdiqləməyincə heç nə göndərilmir.`,
    parse_mode: 'Markdown',
    // The buttons belong to this photo, so they are inline — but `🏠 Menyu` is
    // on the row as well, because this is the last message of the flow and a
    // merchandiser who is unsure what to do next should not have to type
    // anything to find out.
    reply_markup: new InlineKeyboard()
      .text('✅ Təsdiqlə və göndər', encodeCallback('confirm', taskId))
      .row()
      .text('🔄 Yenidən çək', encodeCallback('retake', taskId))
      .text(MENU_HOME_LABEL, encodeCallback('menu', 'home')),
  });
}

/**
 * A photo arrived with no task open — turn the dead end into a task picker.
 *
 * WHY THIS REPLACED A ONE-LINE REFUSAL
 * ------------------------------------
 * The photo is the last step of the guided flow, so a photo sent before a task
 * is opened has nothing to attach to. The old reply said "select a task from the
 * list first" and handed back the reply keyboard — which lists *Tapşırıqlar* and
 * *Statusum*, not the tasks themselves. So a merchandiser standing at the shelf,
 * having just taken a photo, was refused and pointed at a menu, from which they
 * had to open the task list, find the right task, and only then start the flow.
 * It reads as the bot rejecting a perfectly good photo for no reason, and it is
 * the most common complaint about this channel.
 *
 * So the store's own active tasks are offered right here, each as a one-tap
 * button carrying the same `open:` action a task card does. Tapping one selects
 * the task and starts the guided flow (location → checklist → photo), exactly as
 * opening it from `/tasks` would.
 *
 * WHY THE PHOTO IS NOT AUTO-ATTACHED
 * ----------------------------------
 * Even when there is only one active task, the photo is not filed against it.
 * Attaching a photo to a task the merchandiser did not choose is the misfiled-
 * evidence failure the rest of this flow exists to prevent, and the location and
 * checklist have not been collected yet — the photo must still come last. One
 * tap to confirm which task is cheap; a wrong audit is not. The photo just sent
 * is re-sent at the photo step, where the merchandiser is already standing.
 */
async function promptTaskSelectionForPhoto(ctx: BotContext, storeId: string): Promise<void> {
  let tasks;
  try {
    tasks = await portalApi.getTasksForStore(storeId);
  } catch (error) {
    const detail = error instanceof PortalApiError ? error.message : String(error);
    console.error(`[oneTeam Bot] Task lookup for an unattached photo failed (${storeId}):`, detail);
    await ctx.reply(
      `⚠️ *Şəkil üçün tapşırıq seçilməyib.*\n\n` +
        `Tapşırıqları indi yükləyə bilmədim. Zəhmət olmasa aşağıdaki *"📋 Tapşırıqlar"* düyməsi ilə yenidən cəhd edin.`,
      { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() },
    );
    return;
  }

  if (tasks.length === 0) {
    await ctx.reply(
      `📭 *Şəkil üçün açıq tapşırıq yoxdur.*\n\n` +
        `Hazırda mağazanız üçün aktiv rəf tapşırığı görünmür. Yeni tapşırıq təyin olunanda bu çatda bildiriş alacaqsınız.`,
      { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() },
    );
    return;
  }

  // Telegram inline keyboards get unwieldy past a handful of rows; show the first
  // few and offer the full list as a fallback so a store with many tasks is not
  // truncated silently.
  const MAX_BUTTONS = 8;
  const shown = tasks.slice(0, MAX_BUTTONS);

  const keyboard = new InlineKeyboard();
  for (const task of shown) {
    keyboard.text(`📸 ${task.title}`, encodeCallback('open', task.id)).row();
  }
  if (tasks.length > MAX_BUTTONS) {
    keyboard.text('📋 Bütün tapşırıqlar', encodeCallback('tasks', 'list')).row();
  }

  const lead =
    tasks.length === 1
      ? `Şəkli hansı tapşırıq üçün göndərdiyinizi bilməliyəm. Aşağıdaki tapşırığa toxunun — sizi lokasiya və çeklist addımlarından keçirəcəyəm, sonra şəkli yenidən göndərəcəksiniz.`
      : `Şəkli hansı tapşırıq üçün göndərdiyinizi seçin. Tapşırığa toxunduqdan sonra sizi lokasiya və çeklist addımlarından keçirib şəkli yenidən istəyəcəyəm.`;

  await ctx.reply(`📌 *Əvvəlcə tapşırığı seçin*\n\n${lead}`, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
}

/**
 * Throws the waiting photo away and asks for another one.
 *
 * Guarded by the same state as the confirm: a duplicate tap finds no
 * `pendingPhoto` and is answered with a toast instead of clearing the flow.
 */
export async function handleRetakePhoto(
  ctx: BotContext,
  taskId: string,
  answer: AnswerCallback,
): Promise<void> {
  if (!ctx.session.pendingPhoto) {
    await answer('Gözləyən şəkil yoxdur.');
    return;
  }
  if (ctx.session.activeTaskId !== taskId) {
    await answer('Bu tapşırıq artıq aktiv deyil.');
    return;
  }

  await answer();

  ctx.session.pendingPhoto = undefined;
  ctx.session.step = 'awaiting_photo';

  await ctx.reply(
    `🔄 *Yaxşı.* Köhnə şəkil atıldı.\n\n` +
      `İndi yoxlanılan rəfin / soyuducunun aydın fotosunu çəkib bu çatda göndərin.`,
    { parse_mode: 'Markdown' },
  );
}

/**
 * Files the photo that is waiting.
 *
 * See the file header for why the guard is the whole of the idempotency, and
 * why a failure leaves the photo in place.
 */
export async function handleConfirmPhoto(
  ctx: BotContext,
  taskId: string,
  answer: AnswerCallback,
): Promise<void> {
  const pending = ctx.session.pendingPhoto;

  // The guard. A second tap after a successful confirm finds the session
  // already reset, and is answered rather than acted on.
  if (ctx.session.step !== 'awaiting_confirm' || !pending) {
    await answer('Bu şəkil artıq göndərilib.');
    return;
  }

  if (ctx.session.activeTaskId !== taskId) {
    await answer('Bu tapşırıq artıq aktiv deyil.');
    return;
  }

  const storeId = ctx.session.storeId;
  if (!storeId) {
    await answer('Mağaza qeydiyyatı tapılmadı.');
    return;
  }

  // Answered before the work, not after: the button spins until the query is
  // answered, and the work below is several network round trips long.
  await answer();

  try {
    await filePhoto(ctx, pending, taskId, storeId);
  } catch (error) {
    const detail = error instanceof PortalApiError ? error.message : (error as Error)?.message;
    console.error(`[oneTeam Bot] Photo submission failed for task ${taskId}:`, detail);

    // `pendingPhoto` is deliberately left where it was, so the confirm button
    // still works. Making the merchandiser re-shoot a photo the bot already has
    // would be a cost invented by the bot.
    await ctx.reply(
      `❌ *Şəkil qeydə alına bilmədi.*\n\n` +
        `\`${detail}\`\n\n` +
        `Şəkil hələ də sizinlədir — bir az sonra yenidən *✅ Təsdiqlə və göndər* düyməsinə basın.`,
      { parse_mode: 'Markdown' },
    );
  }
}

/** Downloads, prepares and files the photo. Throws on any failure. */
async function filePhoto(
  ctx: BotContext,
  pending: PendingPhoto,
  taskId: string,
  storeId: string,
): Promise<void> {
  let fileBuffer: Buffer;

  // Retrieve file path and download from Telegram servers
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (ctx.api && botToken && !botToken.includes('mockBotToken')) {
    // grammY's API methods take an AbortSignal as their final positional
    // argument (getFile has no "other" options), so the timeout is passed
    // directly here, not wrapped in a `{ signal }` object like fetch below.
    const fileInfo = await ctx.api.getFile(
      pending.fileId,
      AbortSignal.timeout(PHOTO_FETCH_TIMEOUT_MS),
    );
    if (!fileInfo.file_path) {
      throw new Error('Telegram file path not returned');
    }

    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`;
    const response = await fetch(fileUrl, {
      signal: AbortSignal.timeout(PHOTO_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Failed to download photo from Telegram: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    fileBuffer = Buffer.from(arrayBuffer);
  } else {
    // Offline / Test Runner fallback mock buffer
    fileBuffer = Buffer.from(`mock-binary-photo-data-${pending.fileId}`);
  }

  // Get the photo into storage and get back the URL to submit.
  //
  // Preferred path is a presigned direct upload straight to the bucket (R2);
  // it falls back to an inline `data:` URL when no bucket is configured or the
  // direct upload fails. See portalApi.uploadShelfPhoto for the whole picture.
  const fileName = `audits/${storeId}/${taskId}_${Date.now()}.jpg`;
  const photoUrl = await portalApi.uploadShelfPhoto({
    fileBuffer,
    fileName,
    contentType: 'image/jpeg',
  });

  // File the audit against the store task.
  //
  // `submittedBy` is gone from this call on purpose: the API resolves the
  // acting person from `chatId`, which the bot reads off the update it is
  // handling. A caller-supplied user id would be a way to file an audit in
  // someone else's name.
  //
  // `latitude`/`longitude` and `checklistAnswers` come from the guided flow.
  // When the merchandiser skipped the location prompt they are undefined, and
  // the API is told so explicitly — see `createSubmission` for why the store's
  // own coordinates must never be substituted.
  const location = ctx.session.location;
  const checklistAnswers = ctx.session.checklistAnswers ?? [];

  // --- AI vision pass (Phase 2.2) ------------------------------------------
  //
  // Runs HERE, in the bot, because this is where the decoded bytes already are:
  // `fileBuffer` was just downloaded from Telegram, so the engine inlines it
  // without a second fetch and without the photo leaving this process a second
  // time. Which engine runs — or whether any does — is chosen by env on THIS
  // service (`ONETEAM_VISION_PROVIDER`); the default is `off`, and then
  // `resolveVisionProvider` returns null and everything below is exactly the
  // pre-vision flow: no score, human review.
  //
  // A slow or failing model must never cost a merchandiser a real audit. Any
  // throw is caught and treated as "no AI read", which the API records as a
  // pending human review — never a fabricated verdict.
  let ai: VisionAnalysis | null = null;
  const visionProvider = resolveVisionProvider(process.env);
  if (visionProvider) {
    await ctx
      .reply('🔍 *Süni intellekt rəf şəklini yoxlayır...*', { parse_mode: 'Markdown' })
      .catch(() => undefined);
    try {
      ai = await visionProvider.analyze({
        photoUrl,
        imageBuffer: fileBuffer,
        taskTitle: ctx.session.activeTaskTitle,
      });
    } catch (error) {
      console.warn(
        `[oneTeam Bot] Vision analysis failed for task ${taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      ai = null;
    }
  }

  const submission = await portalApi.createSubmission({
    storeTaskId: taskId,
    chatId: ctx.chat!.id,
    photoUrl,
    latitude: location?.latitude,
    longitude: location?.longitude,
    // Telegram's own capture time for the shared location. The API refuses an
    // undated fix, so omitting it here would make every Telegram submission
    // with a location fail as stale.
    locatedAt: location?.locatedAt,
    checklistAnswers,
    ai: ai
      ? {
          score: ai.complianceScore,
          summary: ai.summary,
          detections: ai.detections,
          confidence: ai.confidence,
          needsHumanReview: ai.needsHumanReview,
          engine: ai.engine,
          model: ai.model,
        }
      : undefined,
    metadata: {
      telegram_user_id: ctx.from?.id,
      telegram_chat_id: ctx.chat?.id,
      telegram_username: ctx.from?.username,
      message_id: pending.messageId,
      file_id: pending.fileId,
      file_size: pending.fileSize,
      width: pending.width,
      height: pending.height,
      captured_at: new Date().toISOString(),
      // Recorded so the two controls this flow now applies can be audited
      // from the evidence record alone, without replaying the conversation.
      location_verified: Boolean(location),
      checklist_answer_count: checklistAnswers.length,
      // Phase 2.1: the merchandiser saw this photo and accepted it before it was
      // filed. Recorded because it is a fact about the evidence that a
      // supervisor may want to weigh, and because it is the only way to tell a
      // confirmed submission from one filed by an older version of the bot.
      confirmed_by_submitter: true,
      // Where the photo would live once object storage exists. Recorded now so
      // the images can be lifted out of the database without guessing.
      storage_path: fileName,
      storage: 'inline-data-url',
    },
  });

  // Reset the flow. This is also what makes a duplicate confirm a no-op.
  ctx.session.step = 'idle';
  ctx.session.activeTaskId = undefined;
  ctx.session.activeTaskTitle = undefined;
  ctx.session.location = undefined;
  ctx.session.checklistQuestions = undefined;
  ctx.session.checklistAnswers = undefined;
  ctx.session.checklistIndex = undefined;
  ctx.session.pendingPhoto = undefined;

  console.log(
    `[oneTeam Bot] Audit ${submission.id} filed for task ${taskId} by chat ${ctx.chat?.id}`,
  );

  // WHAT HAPPENED TO THE "AI SCORE" THIS MESSAGE USED TO SHOW
  // -------------------------------------------------------
  // It is gone, and it is not coming back as it was.
  //
  // The badge was fed by `src/services/aiVision.ts`, which never looked at the
  // photo. It picked one of four hardcoded detection layouts by searching the
  // *file name* for words like "gap" or "missing", and every generated name
  // matched none of them, so every merchandiser saw the same flattering score
  // for every photo ever submitted.
  //
  // Showing a number that no one computed is worse than showing none: it is a
  // claim about the shelf that a supervisor might act on. The real score now
  // comes from the supervisor's review, or from the panel's rule-based
  // auto-approval, which scores signals that genuinely exist in the record.
  //
  // The honest thing this message *can* say is what was actually verified.
  // Since the guided flow now collects both, it reports both — and says so
  // plainly when either is missing, because that is what a supervisor will
  // see on the record.
  const locationLine = location
    ? `📍 *Geolokasiya:* ✅ Təsdiqləndi (${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)})\n`
    : `📍 *Geolokasiya:* ⚠️ Təsdiqlənməyib — lokasiya paylaşılmadı.\n`;

  const checklistLine =
    checklistAnswers.length > 0
      ? `📋 *Çeklist:* ✅ ${checklistAnswers.length} sual cavablandırıldı\n`
      : `📋 *Çeklist:* ⚠️ Cavabsız qeydə alındı\n`;

  // The AI read, shown only when an engine actually ran. `submission.ai_score`
  // is the API's persisted value (authoritative), so it is preferred over the
  // local `ai`; the local object is the fallback and the flag for "vision was
  // attempted". When vision is off there is no line at all — the same message a
  // pre-vision submission produced.
  const aiScore = submission.ai_score ?? ai?.complianceScore;
  const aiSummary = submission.ai_summary ?? ai?.summary;
  let aiLine = '';
  if (typeof aiScore === 'number') {
    const summaryText = aiSummary ? `\n_${escapeMarkdown(aiSummary)}_` : '';
    aiLine = `🤖 *AI qiyməti:* ${Math.round(aiScore)}/100${summaryText}\n`;
  } else if (visionProvider) {
    // An engine was configured but returned nothing (failure / rate limit).
    // Said plainly rather than hidden: the audit is safe, a human will look.
    aiLine = `🤖 *AI yoxlanışı:* ⚠️ tamamlanmadı — nəzarətçi yoxlayacaq\n`;
  }

  // The verdict comes from the API, not from the bot: the auto-approve decision
  // is made server-side (score ≥ 85 and the model was confident), and the bot
  // only reports what came back so the two can never disagree.
  const statusLine =
    submission.status === 'approved'
      ? `📦 *Status:* ✅ Avtomatik təsdiqləndi\n`
      : submission.status === 'rejected'
        ? `📦 *Status:* ❌ İmtina edildi\n`
        : `📦 *Status:* ⏳ Yoxlama gözləyir\n`;

  const headerLine =
    submission.status === 'approved'
      ? `✅ *Əla! Rəf şəkliniz süni intellekt tərəfindən təsdiqləndi.*`
      : `✅ *Təşəkkür edirik! Rəf şəkli qeydə alındı.*`;

  const confirmationText =
    `${headerLine}\n\n` +
    `🏪 *Mağaza:* ${escapeMarkdown(ctx.session.storeName ?? '')}\n` +
    statusLine +
    aiLine +
    locationLine +
    checklistLine +
    `\nStatusunuzu yoxlamaq üçün istənilən vaxt aşağıdaki menyudan istifadə edə bilərsiniz.`;

  // The reply keyboard, not the inline one: this message ends the flow, and the
  // flow is what dismissed the reply keyboard in the first place (the location
  // step's `oneTime()` keyboard). Ending by handing the buttons back is what
  // makes the next task reachable without typing.
  await ctx.reply(confirmationText, {
    parse_mode: 'Markdown',
    reply_markup: mainMenuKeyboard(),
  });
}
