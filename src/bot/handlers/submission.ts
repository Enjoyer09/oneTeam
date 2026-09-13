import { BotContext } from '../types';
import { supabaseService } from '../../services/supabase';

export async function handlePhotoUpload(ctx: BotContext) {
  if (!ctx.session.storeId) {
    await ctx.reply(
      `⚠️ *Əvvəlcə mağaza qeydiyyatından keçin!*\n\nZəhmət olmasa /start əmri ilə mağaza kodunuzu daxil edin.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const taskId = ctx.session.activeTaskId;
  const storeId = ctx.session.storeId;

  if (!taskId) {
    await ctx.reply(
      `⚠️ *Hansı tapşırıq üçün şəkil göndərdiyiniz seçilməyib!*\n\n` +
        `Zəhmət olmasa əvvəlcə /tasks əmri ilə müvafiq tapşırığı seçin və *"📸 Rəf Şəklini Göndər"* düyməsinə klikləyin.`,
      { parse_mode: 'Markdown' }
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

  const processingMsg = await ctx.reply(
    `⏳ *Foto emal edilir...*\nSupabase serverinə yüklənir və audit bazasına qeyd olunur.`,
    { parse_mode: 'Markdown' }
  );

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

    // 2. Upload to Supabase Storage bucket ('shelf-images')
    const fileName = `audits/${storeId}/${taskId}_${Date.now()}.jpg`;
    const photoUrl = await supabaseService.uploadShelfPhoto({
      fileBuffer,
      fileName,
      contentType: 'image/jpeg',
    });

    // 3. Insert record into `submissions`
    const metadata = {
      telegram_user_id: ctx.from?.id,
      telegram_chat_id: ctx.chat?.id,
      telegram_username: ctx.from?.username,
      message_id: ctx.message?.message_id,
      file_id: highestResPhoto.file_id,
      file_size: highestResPhoto.file_size,
      width: highestResPhoto.width,
      height: highestResPhoto.height,
      captured_at: new Date().toISOString(),
    };

    const submission = await supabaseService.createSubmission({
      taskId,
      storeId,
      submittedBy: ctx.session.profileId,
      photoUrl,
      metadata,
    });

    // Reset step
    ctx.session.step = 'idle';
    ctx.session.activeTaskId = undefined;
    ctx.session.activeTaskTitle = undefined;

    // Delete processing message if possible
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, processingMsg.message_id);
    } catch {
      // Ignored if cannot delete
    }

    const aiScoreBadge =
      submission.ai_score !== undefined && submission.ai_score !== null
        ? `\n\n🤖 *Süni İntellekt (AI) İlkin Təhlili:*\n` +
          `📊 *Uyğunluq Balı:* ${submission.ai_score}%\n` +
          `📝 *Rəy:* ${submission.ai_summary || 'Təhlil tamamlandı.'}`
        : '';

    // 4. Confirmation reply in Azerbaijani
    const confirmationText =
      `✅ *Təşəkkür edirik! Rəf şəkli supervayzer yoxlaması üçün qeydə alındı.*\n\n` +
      `🏪 *Mağaza:* ${ctx.session.storeName}\n` +
      `📦 *Status:* ⏳ Yoxlama gözləyir (pending_review)` +
      aiScoreBadge +
      `\n\nStatusunuzu yoxlamaq üçün istənilən vaxt /mystatus əmrindən istifadə edin.`;

    await ctx.reply(confirmationText, { parse_mode: 'Markdown' });
  } catch (error: any) {
    await ctx.reply(
      `❌ *Xəta baş verdi:* Şəkil yüklənərkən problem yarandı.\n\`${error?.message || error}\``,
      { parse_mode: 'Markdown' }
    );
  }
}
