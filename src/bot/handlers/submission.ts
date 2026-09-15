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
import { encodeCallback } from '../callbacks';
import { mainMenuInline } from '../keyboards';

/** What is held between the photo arriving and the merchandiser confirming it. */
type PendingPhoto = NonNullable<BotContext['session']['pendingPhoto']>;

export async function handlePhotoArrival(ctx: BotContext): Promise<void> {
  if (!ctx.session.storeId) {
    await ctx.reply(
      `⚠️ *Əvvəlcə mağaza qeydiyyatından keçin!*\n\nZəhmət olmasa /start əmri ilə mağaza kodunuzu daxil edin.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const taskId = ctx.session.activeTaskId;

  if (!taskId) {
    await ctx.reply(
      `⚠️ *Hansı tapşırıq üçün şəkil göndərdiyiniz seçilməyib!*\n\n` +
        `Zəhmət olmasa əvvəlcə tapşırıqlar siyahısından müvafiq tapşırığı seçin.`,
      { parse_mode: 'Markdown', reply_markup: mainMenuInline() },
    );
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
      `📌 *${ctx.session.activeTaskTitle ?? 'Tapşırıq'}*\n` +
      checklistLine +
      locationLine +
      `\nBu şəkil nəzarətçiyə göndəriləcək. Aydındırsa *✅ Təsdiqlə və göndər* düyməsinə basın.\n` +
      `Əgər bulanıqdır, brend etiketləri görünmür və ya yanlış rəfdirsə — *🔄 Yenidən çək* düyməsinə basın.\n\n` +
      `Təsdiqləməyincə heç nə göndərilmir.`,
    parse_mode: 'Markdown',
    reply_markup: new InlineKeyboard()
      .text('✅ Təsdiqlə və göndər', encodeCallback('confirm', taskId))
      .row()
      .text('🔄 Yenidən çək', encodeCallback('retake', taskId)),
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
    const fileInfo = await ctx.api.getFile(pending.fileId);
    if (!fileInfo.file_path) {
      throw new Error('Telegram file path not returned');
    }

    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download photo from Telegram: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    fileBuffer = Buffer.from(arrayBuffer);
  } else {
    // Offline / Test Runner fallback mock buffer
    fileBuffer = Buffer.from(`mock-binary-photo-data-${pending.fileId}`);
  }

  // Prepare the photo for transport.
  //
  // There is no object store yet, so this returns an inline `data:` URL rather
  // than a hosted link. See portalApi.uploadShelfPhoto for what that costs and
  // why it is temporary.
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

  const submission = await portalApi.createSubmission({
    storeTaskId: taskId,
    chatId: ctx.chat!.id,
    photoUrl,
    latitude: location?.latitude,
    longitude: location?.longitude,
    checklistAnswers,
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

  const confirmationText =
    `✅ *Təşəkkür edirik! Rəf şəkli nəzarətçi yoxlaması üçün qeydə alındı.*\n\n` +
    `🏪 *Mağaza:* ${ctx.session.storeName}\n` +
    `📦 *Status:* ⏳ Yoxlama gözləyir\n` +
    locationLine +
    checklistLine +
    `\nStatusunuzu yoxlamaq üçün istənilən vaxt aşağıdaki düymədən istifadə edə bilərsiniz.`;

  await ctx.reply(confirmationText, {
    parse_mode: 'Markdown',
    reply_markup: mainMenuInline(),
  });
}
