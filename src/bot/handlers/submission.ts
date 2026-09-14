import { BotContext } from '../types';
import { portalApi, PortalApiError } from '../../services/portalApi';

export async function handlePhotoUpload(ctx: BotContext) {
  if (!ctx.session.storeId) {
    await ctx.reply(
      `⚠️ *Əvvəlcə mağaza qeydiyyatından keçin!*\n\nZəhmət olmasa /start əmri ilə mağaza kodunuzu daxil edin.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const taskId = ctx.session.activeTaskId;
  const storeId = ctx.session.storeId;

  if (!taskId) {
    await ctx.reply(
      `⚠️ *Hansı tapşırıq üçün şəkil göndərdiyiniz seçilməyib!*\n\n` +
        `Zəhmət olmasa əvvəlcə /tasks əmri ilə müvafiq tapşırığı seçin və *"📸 Rəf Şəklini Göndər"* düyməsinə klikləyin.`,
      { parse_mode: 'Markdown' },
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

  const processingMsg = await ctx.reply(`⏳ *Foto qeydə alınır...*`, { parse_mode: 'Markdown' });

  try {
    let fileBuffer: Buffer;

    // Retrieve file path and download from Telegram servers
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (ctx.api && botToken && !botToken.includes('mockBotToken')) {
      const fileInfo = await ctx.api.getFile(highestResPhoto.file_id);
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
      fileBuffer = Buffer.from(`mock-binary-photo-data-${highestResPhoto.file_id}`);
    }

    // 2. Prepare the photo for transport.
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

    // 3. File the audit against the store task.
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
        message_id: ctx.message?.message_id,
        file_id: highestResPhoto.file_id,
        file_size: highestResPhoto.file_size,
        width: highestResPhoto.width,
        height: highestResPhoto.height,
        captured_at: new Date().toISOString(),
        // Recorded so the two controls this flow now applies can be audited
        // from the evidence record alone, without replaying the conversation.
        location_verified: Boolean(location),
        checklist_answer_count: checklistAnswers.length,
        // Where the photo would live once object storage exists. Recorded now so
        // the images can be lifted out of the database without guessing.
        storage_path: fileName,
        storage: 'inline-data-url',
      },
    });

    // Reset step
    ctx.session.step = 'idle';
    ctx.session.activeTaskId = undefined;
    ctx.session.activeTaskTitle = undefined;
    ctx.session.location = undefined;
    ctx.session.checklistQuestions = undefined;
    ctx.session.checklistAnswers = undefined;
    ctx.session.checklistIndex = undefined;

    console.log(
      `[oneTeam Bot] Audit ${submission.id} filed for task ${taskId} by chat ${ctx.chat?.id}`,
    );

    // Delete processing message if possible
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, processingMsg.message_id);
    } catch {
      // Ignored if cannot delete
    }

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
      `✅ *Təşəkkür edirik! Rəf şəkli supervayzer yoxlaması üçün qeydə alındı.*\n\n` +
      `🏪 *Mağaza:* ${ctx.session.storeName}\n` +
      `📦 *Status:* ⏳ Yoxlama gözləyir\n` +
      locationLine +
      checklistLine +
      `\nStatusunuzu yoxlamaq üçün istənilən vaxt /mystatus əmrindən istifadə edin.`;

    await ctx.reply(confirmationText, { parse_mode: 'Markdown' });
  } catch (error: any) {
    const detail = error instanceof PortalApiError ? error.message : error?.message || error;
    console.error(`[oneTeam Bot] Photo submission failed for task ${taskId}:`, detail);

    await ctx.reply(`❌ *Xəta baş verdi:* Şəkil qeydə alına bilmədi.\n\`${detail}\``, {
      parse_mode: 'Markdown',
    });
  }
}
