/**
 * oneTeam Telegram Bot — the guided field flow
 * ============================================================================
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * Opening a task in the chat used to jump straight to "send me a photo". Two
 * controls were therefore never applied on this channel, and both gaps were
 * recorded rather than hidden:
 *
 *   - the anti-fraud geofence, because a Telegram photo carries no coordinates;
 *   - the template's checklist, because nobody asked the questions.
 *
 * Recording a gap honestly is better than faking a pass, but it is not a fix.
 * This module runs the two steps that close them, in the order that costs the
 * merchandiser the least effort:
 *
 *     1. location   — one tap, taken while they are still at the shelf
 *     2. checklist  — the template's own questions, one at a time
 *     3. photo      — accepted last, now carrying both
 *
 * WHY LOCATION COMES FIRST
 * ------------------------
 * The location is a single tap and it is only meaningful while the person is
 * standing in the store. Asking for it after the checklist — which takes a
 * minute of walking the aisle — would invite a stale fix. It also means a
 * merchandiser who is *not* in the store finds out immediately, instead of
 * after answering three questions and taking a photo.
 *
 * WHY SKIPPING IS ALLOWED
 * -----------------------
 * A location can genuinely fail: indoor GPS, a phone with location services
 * off, a merchandiser who does not want to be tracked. Refusing the photo
 * outright would make the bot unusable for those people and they would go back
 * to sending photos on WhatsApp, where there is no record at all.
 *
 * So skipping is permitted and *recorded*. The submission goes to the API with
 * `locationUnverified: true`, the API writes a `GEOFENCE_NOT_VERIFIED` audit
 * event, and the confirmation message tells the merchandiser — in plain words —
 * that a supervisor will see this audit as weaker evidence. The gap stays
 * visible, which is the whole difference from the old behaviour.
 *
 * The checklist has no skip. The questions are short, they are what the audit
 * is *for*, and an unanswered required question is refused by the API anyway —
 * so offering a skip button would only produce a submission that fails at the
 * end of the flow. A merchandiser who cannot answer can go back with /tasks and
 * choose a different task.
 */

import { InlineKeyboard } from 'grammy';
import { ChecklistAnswer, ChecklistQuestion } from '@oneteam/types';
import { BotContext } from '../types';
import { LOCATION_SKIP_LABEL, locationRequestKeyboard, mainMenuKeyboard } from '../keyboards';

/** Prefix for checklist callback data: `chk_<index>_<kind>_<value>`. */
export const CHECKLIST_CALLBACK_PREFIX = 'chk';

/**
 * Escapes the characters Telegram's legacy Markdown treats as formatting.
 *
 * Question text is authored by a supervisor in the panel, so it can contain
 * anything. An unescaped `_` or `*` makes Telegram reject the whole message with
 * a 400, which would present as "the bot is broken" for one specific question.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*`[\]]/g, (char) => `\\${char}`);
}

/** Human-readable bounds for a number question, when the template sets them. */
function numberHint(question: ChecklistQuestion): string {
  const unit = question.unit ? ` ${question.unit}` : '';
  if (question.minValue !== undefined && question.maxValue !== undefined) {
    return `\n\nℹ️ Qəbul olunan aralıq: *${question.minValue}${unit}* — *${question.maxValue}${unit}*`;
  }
  if (question.minValue !== undefined) {
    return `\n\nℹ️ Minimum: *${question.minValue}${unit}*`;
  }
  if (question.maxValue !== undefined) {
    return `\n\nℹ️ Maksimum: *${question.maxValue}${unit}*`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Step 1 — location
// ---------------------------------------------------------------------------

/**
 * Starts the guided flow for the task the merchandiser just opened.
 *
 * The questions are passed IN rather than read from the session, because this
 * function also has to clear the session — and clearing it after the caller had
 * stored the questions silently wiped them, which skipped the whole checklist
 * and filed an audit with no answers. Taking them as an argument makes that
 * ordering impossible to get wrong.
 *
 * Answers and location from a previous task are cleared for the same reason in
 * reverse: a session that still holds last task's answers would file them
 * against this one, and that is a data-integrity bug that looks like a user
 * mistake.
 */
export async function beginTaskFlow(
  ctx: BotContext,
  questions: ChecklistQuestion[] = [],
): Promise<void> {
  ctx.session.step = 'awaiting_location';
  ctx.session.location = undefined;
  ctx.session.checklistQuestions = questions;
  ctx.session.checklistAnswers = undefined;
  ctx.session.checklistIndex = undefined;

  await ctx.reply(
    `📍 *Addım 1/3 — Lokasiya*\n\n` +
      `Zəhmət olmasa aşağıdaki *"📍 Lokasiyamı göndər"* düyməsinə basıb olduğunuz yeri paylaşın.\n\n` +
      `Bu, auditin həqiqətən mağazada çəkildiyini təsdiqləyir. Paylaşmasanız şəkil yenə qəbul ediləcək, ` +
      `amma audit *lokasiya təsdiqlənməmiş* kimi qeyd olunacaq və nəzarətçi bunu görəcək.`,
    { parse_mode: 'Markdown', reply_markup: locationRequestKeyboard() },
  );
}

/**
 * Handles a shared location.
 *
 * Always returns true for a location message: falling through to the text
 * router would leave the user with no reply at all, which reads as the bot
 * being down.
 */
export async function handleLocationMessage(ctx: BotContext): Promise<boolean> {
  const location = ctx.message?.location;
  if (!location) return false;

  if (ctx.session.step !== 'awaiting_location') {
    await ctx.reply(
      `ℹ️ Lokasiya qeydə alındı, amma hazırda seçilmiş tapşırıq yoxdur.\n\n` +
        `Zəhmət olmasa əvvəlcə /tasks əmri ilə tapşırığı seçin.`,
      { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() },
    );
    return true;
  }

  ctx.session.location = {
    latitude: location.latitude,
    longitude: location.longitude,
  };

  await ctx.reply(
    `✅ *Lokasiya qeydə alındı.*\n` +
      `📌 ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`,
    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() },
  );

  await continueAfterLocation(ctx);
  return true;
}

/** Handles the "continue without a location" button. */
export async function handleLocationSkip(ctx: BotContext): Promise<boolean> {
  if (ctx.message?.text?.trim() !== LOCATION_SKIP_LABEL) return false;
  if (ctx.session.step !== 'awaiting_location') return false;

  ctx.session.location = undefined;

  await ctx.reply(
    `⚠️ *Lokasiya paylaşılmadı.*\n\n` +
      `Şəkil qəbul ediləcək, amma audit *lokasiya təsdiqlənməmiş* kimi qeyd olunacaq. ` +
      `Nəzarətçi bunu görəcək.`,
    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() },
  );

  await continueAfterLocation(ctx);
  return true;
}

/** Moves to the checklist when the template has one, otherwise to the photo. */
async function continueAfterLocation(ctx: BotContext): Promise<void> {
  const questions = ctx.session.checklistQuestions ?? [];

  if (questions.length > 0) {
    ctx.session.checklistIndex = 0;
    ctx.session.checklistAnswers = [];
    await askNextChecklistQuestion(ctx);
    return;
  }

  await requestShelfPhoto(ctx);
}

// ---------------------------------------------------------------------------
// Step 2 — checklist
// ---------------------------------------------------------------------------

/**
 * Asks the question at the session cursor, or moves on when there are none
 * left. Called both to start the checklist and after every answer, so the
 * "what comes next" decision exists in exactly one place.
 */
export async function askNextChecklistQuestion(ctx: BotContext): Promise<void> {
  const questions = ctx.session.checklistQuestions ?? [];
  const index = ctx.session.checklistIndex ?? 0;
  const question = questions[index];

  if (!question) {
    await requestShelfPhoto(ctx);
    return;
  }

  ctx.session.step = 'awaiting_checklist';

  const header =
    `📋 *Addım 2/3 — Çeklist* (${index + 1}/${questions.length})\n\n` +
    `*${escapeMarkdown(question.question)}*` +
    (question.unit ? ` _(${escapeMarkdown(question.unit)})_` : '');

  if (question.type === 'boolean') {
    await ctx.reply(header, {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard()
        .text('✅ Bəli', `${CHECKLIST_CALLBACK_PREFIX}_${index}_bool_true`)
        .text('❌ Xeyr', `${CHECKLIST_CALLBACK_PREFIX}_${index}_bool_false`),
    });
    return;
  }

  if (question.type === 'single_choice' && question.options?.length) {
    const keyboard = new InlineKeyboard();
    question.options.forEach((option, optionIndex) => {
      keyboard.text(option, `${CHECKLIST_CALLBACK_PREFIX}_${index}_opt_${optionIndex}`).row();
    });
    await ctx.reply(header, { parse_mode: 'Markdown', reply_markup: keyboard });
    return;
  }

  // A number question has no buttons: the answer is a typed value, which is why
  // `handleChecklistText` exists and why the session stays in this step.
  await ctx.reply(`${header}${numberHint(question)}\n\n✍️ Cavabı rəqəmlə yazıb göndərin.`, {
    parse_mode: 'Markdown',
  });
}

/**
 * Handles a tap on a checklist answer button.
 *
 * Returns false when the callback is not ours, so the router can pass it on.
 */
export async function handleChecklistCallback(ctx: BotContext): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(`${CHECKLIST_CALLBACK_PREFIX}_`)) return false;

  const [prefix, rawIndex, kind, ...rest] = data.split('_');
  const index = Number(rawIndex);
  const rawValue = rest.join('_');

  const questions = ctx.session.checklistQuestions ?? [];
  const question = questions[index];

  if (!question || Number.isNaN(index)) {
    await ctx.answerCallbackQuery({ text: 'Sual tapılmadı. /tasks ilə yenidən başlayın.' });
    return true;
  }

  // A tap on an older message would otherwise overwrite a newer answer, or file
  // an answer for a task the merchandiser has since moved away from.
  if (ctx.session.checklistIndex !== index) {
    await ctx.answerCallbackQuery({ text: 'Bu sual artıq cavablandırılıb.' });
    return true;
  }

  let value: boolean | number | string | undefined;

  if (kind === 'bool') {
    value = rawValue === 'true';
  } else if (kind === 'opt') {
    // The API validates the value against `options` and refuses anything else,
    // so an out-of-range index is caught here where it can be explained.
    value = question.options?.[Number(rawValue)];
  }

  if (value === undefined) {
    await ctx.answerCallbackQuery({ text: 'Cavab tanınmadı, yenidən cəhd edin.' });
    return true;
  }

  await ctx.answerCallbackQuery();
  await recordChecklistAnswer(ctx, question, value);
  return true;
}

/**
 * Handles a typed answer for a number question.
 *
 * Returns false when the chat is not mid-checklist, so ordinary text keeps
 * flowing to the router's other branches.
 */
export async function handleChecklistText(ctx: BotContext): Promise<boolean> {
  if (ctx.session.step !== 'awaiting_checklist') return false;

  const questions = ctx.session.checklistQuestions ?? [];
  const index = ctx.session.checklistIndex ?? 0;
  const question = questions[index];
  if (!question) return false;

  // Typed text on a question that has buttons means the merchandiser typed
  // instead of tapping. Saying so is better than silently ignoring the message.
  if (question.type !== 'number') {
    await ctx.reply(`ℹ️ Zəhmət olmasa yuxarıdaki düymələrdən birini seçin.`);
    return true;
  }

  const text = ctx.message?.text?.trim() ?? '';
  // A comma is the decimal separator in Azerbaijani, so "3,5" is a number here
  // even though `Number("3,5")` is NaN.
  const value = Number(text.replace(',', '.'));

  if (!Number.isFinite(value)) {
    await ctx.reply(`✍️ Zəhmət olmasa cavabı rəqəmlə yazın (məsələn: \`3\`).`, {
      parse_mode: 'Markdown',
    });
    return true;
  }

  const unit = question.unit ? ` ${question.unit}` : '';

  if (question.minValue !== undefined && value < question.minValue) {
    await ctx.reply(
      `⚠️ Daxil etdiyiniz qiymət (*${value}${unit}*) minimum həddən (*${question.minValue}${unit}*) kiçikdir.\n\n` +
        `Zəhmət olmasa yoxlayıb yenidən yazın.`,
      { parse_mode: 'Markdown' },
    );
    return true;
  }

  if (question.maxValue !== undefined && value > question.maxValue) {
    await ctx.reply(
      `⚠️ Daxil etdiyiniz qiymət (*${value}${unit}*) maksimum həddən (*${question.maxValue}${unit}*) böyükdür.\n\n` +
        `Zəhmət olmasa yoxlayıb yenidən yazın.`,
      { parse_mode: 'Markdown' },
    );
    return true;
  }

  await recordChecklistAnswer(ctx, question, value);
  return true;
}

/** Stores one answer and asks the next question. */
async function recordChecklistAnswer(
  ctx: BotContext,
  question: ChecklistQuestion,
  value: boolean | number | string,
): Promise<void> {
  // Filtered rather than pushed, so a corrected answer replaces the old one
  // instead of leaving two entries for the same question for the API to pick
  // between.
  const answers: ChecklistAnswer[] = (ctx.session.checklistAnswers ?? []).filter(
    (answer) => answer.questionId !== question.id,
  );
  answers.push({ questionId: question.id, value });

  ctx.session.checklistAnswers = answers;
  ctx.session.checklistIndex = (ctx.session.checklistIndex ?? 0) + 1;

  await askNextChecklistQuestion(ctx);
}

// ---------------------------------------------------------------------------
// Step 3 — photo
// ---------------------------------------------------------------------------

/** Tells the merchandiser to send the photo, and restores the main menu. */
export async function requestShelfPhoto(ctx: BotContext): Promise<void> {
  ctx.session.step = 'awaiting_photo';

  const answered = ctx.session.checklistAnswers?.length ?? 0;
  const checklistLine = answered > 0 ? `✅ Çeklist cavabları qeydə alındı (${answered}).\n` : '';
  const locationLine = ctx.session.location
    ? `✅ Lokasiya qeydə alındı.\n`
    : `⚠️ Lokasiya paylaşılmadı.\n`;

  await ctx.reply(
    `📸 *Addım 3/3 — Şəkil*\n\n` +
      checklistLine +
      locationLine +
      `\nİndi yoxlanılan rəfin / soyuducunun aydın fotosunu çəkib bu çatda göndərin.\n\n` +
      `💡 *Məsləhət:* Bütün brend etiketlərinin və qiymət kağızlarının kadra düşdüyündən əmin olun.`,
    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() },
  );
}
