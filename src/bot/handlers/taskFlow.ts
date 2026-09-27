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
 *     4. confirm    — the merchandiser sees what was captured before it is filed
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
 *
 * PHASE 2.1 — THE ROUTES THIS FILE'S FUNCTIONS ARE REACHED BY
 * -----------------------------------------------------------
 * These functions were all written and none of them was wired up. `index.ts`
 * imported four of them and called none: there was no `message:location`
 * handler, the text router never reached the checklist, and the single callback
 * handler understood only `submit_`. `src/bot/router.test.ts` now drives the
 * real bot through `bot.handleUpdate` and fails if a route goes missing again.
 */

import { InlineKeyboard } from 'grammy';
import { ChecklistAnswer, ChecklistQuestion } from '@oneteam/types';
import { AnswerCallback, BotContext } from '../types';
import { decodeChecklistAnswer, encodeCallback, encodeChecklistAnswer } from '../callbacks';
import {
  LOCATION_SKIP_LABEL,
  MENU_HOME_LABEL,
  locationRequestKeyboard,
  mainMenuInline,
  mainMenuKeyboard,
} from '../keyboards';
import { escapeMarkdown } from '../markdown';

/**
 * The text of a checklist question.
 *
 * A TEMPORARY BRIDGE OVER A BROKEN CONTRACT — TASK #73
 * ---------------------------------------------------
 * The panel writes a question under `label`, the API stores it under `label`
 * (`PortalService.readChecklistSchema`), and `packages/types` declares the field
 * as `question`. Reading only `question.question` therefore returns `undefined`
 * for every question authored in the panel, and a merchandiser sees the word
 * "undefined" where the question should be — on every question, in every
 * checklist task.
 *
 * This reads both names so that the chat works today. It does NOT settle the
 * contract: whether the stored field should be renamed to `question` (with a
 * backfill) or whether `label` is the canonical name and the TYPE is wrong is
 * still open, and it is still the product owner's call — #73.
 *
 * Why the bridge is here and not left out: this file is being rewritten for
 * Phase 2.1, and writing `question.question` into new code while knowing it
 * returns `undefined` is not "keeping the change small", it is shipping a
 * defect on purpose. The symptom is now covered by a check in
 * `router.test.ts`, so it cannot come back quietly.
 *
 * WHEN #73 IS DECIDED, THIS IS THE ONLY LINE THAT CHANGES.
 */
function questionText(question: ChecklistQuestion): string {
  return question.question ?? question.label ?? '';
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

/**
 * The navigation row offered under every step message: "start over" and "home".
 *
 * Both are on the step messages rather than on the menu messages because that
 * is where they are needed — a merchandiser part way through a checklist is the
 * one who might want out.
 *
 * Only offered where an inline keyboard already exists, because an inline
 * keyboard cannot be sent alongside the reply keyboard the location step needs.
 * The location step does not miss them: tapping the task again from `/tasks` is
 * the same request, and at that point there is nothing to lose.
 *
 * `🏠 Menyu` is what makes the `menu:home` action reachable. Before Phase 2.4
 * the router answered it and no button produced it.
 */
function flowNavKeyboard(taskId: string | undefined): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (taskId) keyboard.text('🔄 Yenidən başla', encodeCallback('restart', taskId));
  return keyboard.text(MENU_HOME_LABEL, encodeCallback('menu', 'home'));
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
  options: { restarted?: boolean } = {},
): Promise<void> {
  ctx.session.step = 'awaiting_location';
  ctx.session.location = undefined;
  ctx.session.checklistQuestions = questions;
  ctx.session.checklistAnswers = undefined;
  ctx.session.checklistIndex = undefined;
  ctx.session.pendingPhoto = undefined;

  const lead = options.restarted ? `🔄 *Yenidən başlanır.* Əvvəlki cavablar silindi.\n\n` : '';

  await ctx.reply(
    lead +
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
        `Zəhmət olmasa əvvəlcə tapşırığı seçin.`,
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
 * How a question is answered: with buttons, or by typing.
 *
 * WHY THIS IS RESOLVED IN ONE PLACE — A DEADLOCK ON TYPE-LESS QUESTIONS
 * --------------------------------------------------------------------
 * `packages/types` declares `type` as required, but the API never sets it: a
 * question authored in the panel is stored as `{ id, label }` with no `type`
 * at all (`PortalService.readChecklistSchema` validates `label` and passes the
 * rest through untouched — the same open-contract gap as #73, one field over).
 *
 * The old code read `question.type` directly in the two functions below, and
 * they DISAGREED about a type-less question. `askNextChecklistQuestion` fell
 * through to the number branch and printed "type a number" with no buttons;
 * `handleChecklistText` saw `type !== 'number'` and answered "use the buttons
 * above" — but there were none. The result was a checklist step that could not
 * be passed at all: nothing to tap, and every typed answer refused. To a
 * merchandiser that is a task whose button "does nothing", which is exactly
 * what was reported on a panel-authored task (IPHONE_TEST — three `{id,label}`
 * questions, no `type`).
 *
 * Deciding the mode once removes the disagreement. A question with no
 * recognised type becomes free text: it is universally answerable, it assumes
 * nothing about intent (a type-less question is NOT necessarily yes/no), and
 * `EvidenceService` applies no type validation to it, so a typed string is
 * accepted on submission. Declaring `type: 'boolean'` in the schema is still
 * the way to get one-tap buttons — that is a schema decision, not a guess this
 * layer is entitled to make.
 */
type AnswerMode = 'boolean' | 'single_choice' | 'number' | 'text';

function answerMode(question: ChecklistQuestion): AnswerMode {
  if (question.type === 'boolean') return 'boolean';
  if (question.type === 'single_choice' && question.options?.length) return 'single_choice';
  if (question.type === 'number') return 'number';
  return 'text';
}

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
    `*${escapeMarkdown(questionText(question))}*` +
    (question.unit ? ` _(${escapeMarkdown(question.unit)})_` : '');

  const mode = answerMode(question);

  if (mode === 'boolean') {
    await ctx.reply(header, {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard()
        .text('✅ Bəli', encodeCallback('chk', encodeChecklistAnswer(index, true)))
        .text('❌ Xeyr', encodeCallback('chk', encodeChecklistAnswer(index, false)))
        .row()
        .append(flowNavKeyboard(ctx.session.activeTaskId)),
    });
    return;
  }

  if (mode === 'single_choice') {
    const keyboard = new InlineKeyboard();
    (question.options ?? []).forEach((option, optionIndex) => {
      keyboard.text(option, encodeCallback('chk', encodeChecklistAnswer(index, optionIndex))).row();
    });
    keyboard.append(flowNavKeyboard(ctx.session.activeTaskId));
    await ctx.reply(header, { parse_mode: 'Markdown', reply_markup: keyboard });
    return;
  }

  if (mode === 'number') {
    // A number question has no buttons: the answer is a typed value, which is
    // why `handleChecklistText` exists and why the session stays in this step.
    await ctx.reply(`${header}${numberHint(question)}\n\n✍️ Cavabı rəqəmlə yazıb göndərin.`, {
      parse_mode: 'Markdown',
      reply_markup: flowNavKeyboard(ctx.session.activeTaskId),
    });
    return;
  }

  // Free text — the fallback for a question the template gave no answer TYPE
  // (see `answerMode`). Like a number question it has no buttons and is
  // answered by typing, but it accepts any text rather than only a number.
  // A panel-authored `{ id, label }` question lands here, and before this
  // branch existed it had nowhere to land — the checklist could not be passed.
  await ctx.reply(`${header}\n\n✍️ Cavabı yazıb göndərin.`, {
    parse_mode: 'Markdown',
    reply_markup: flowNavKeyboard(ctx.session.activeTaskId),
  });
}

/**
 * Handles a tap on a checklist answer button.
 *
 * THE GUARD IS THE IDEMPOTENCY
 * ----------------------------
 * A duplicate tap arrives as a second update carrying the same `callback_data`.
 * By then the first tap has advanced `checklistIndex`, so the index in the
 * second tap no longer matches the question being asked and it is refused with
 * a toast. Nothing is written twice and nothing throws.
 *
 * This works because grammY handles updates sequentially and writes the session
 * between them — see the header of `router.test.ts` for the two line
 * references. The same reasoning protects every guard in this file.
 */
export async function handleChecklistAnswer(
  ctx: BotContext,
  id: string,
  answer: AnswerCallback,
): Promise<void> {
  const decoded = decodeChecklistAnswer(id);
  if (!decoded) {
    await answer('Cavab tanınmadı, yenidən cəhd edin.');
    return;
  }

  const { index } = decoded;
  const questions = ctx.session.checklistQuestions ?? [];
  const question = questions[index];

  if (!question) {
    await answer('Sual tapılmadı. Tapşırıqlar siyahısından yenidən başlayın.');
    return;
  }

  // A tap on an older message would otherwise overwrite a newer answer, or file
  // an answer for a task the merchandiser has since moved away from.
  if (ctx.session.checklistIndex !== index) {
    await answer('Bu sual artıq cavablandırılıb.');
    return;
  }

  let value: boolean | number | string | undefined;

  if (typeof decoded.value === 'boolean') {
    value = decoded.value;
  } else {
    // The API validates the value against `options` and refuses anything else,
    // so an out-of-range index is caught here where it can be explained.
    value = question.options?.[decoded.value];
  }

  if (value === undefined) {
    await answer('Cavab tanınmadı, yenidən cəhd edin.');
    return;
  }

  await answer();
  await recordChecklistAnswer(ctx, question, value);
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

  const mode = answerMode(question);

  // A tapped-answer question (boolean / single_choice) has buttons, so a typed
  // message means the merchandiser typed instead of tapping. Saying so is
  // better than silently ignoring the message.
  if (mode === 'boolean' || mode === 'single_choice') {
    await ctx.reply(`ℹ️ Zəhmət olmasa yuxarıdaki düymələrdən birini seçin.`);
    return true;
  }

  const text = ctx.message?.text?.trim() ?? '';

  // A free-text question takes the message verbatim. This is the branch a
  // type-less panel question reaches; before it existed the message was refused
  // with "use the buttons above" and the flow could not advance — see
  // `answerMode`.
  if (mode === 'text') {
    if (!text) {
      await ctx.reply(`✍️ Zəhmət olmasa cavabı yazıb göndərin.`);
      return true;
    }
    await recordChecklistAnswer(ctx, question, text);
    return true;
  }

  // mode === 'number' from here on.
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
      `💡 *Məsləhət:* Bütün brend etiketlərinin və qiymət kağızlarının kadra düşdüyündən əmin olun.\n\n` +
      `Şəkli göndərdikdən sonra onu *təsdiqləməyiniz* xahiş olunur — səhv çıxsa, yenidən çəkə bilərsiniz.`,
    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() },
  );
}

// ---------------------------------------------------------------------------
// Restarting
// ---------------------------------------------------------------------------

/**
 * Throws the current answers away and starts the task over.
 *
 * The only destructive action in the flow, and the only place answers are
 * discarded. It is offered on an explicit button that says what it does,
 * precisely so that no other action has to guess whether a second tap meant
 * "again" or "start over".
 */
export async function handleRestartTask(
  ctx: BotContext,
  taskId: string,
  answer: AnswerCallback,
): Promise<void> {
  if (ctx.session.activeTaskId !== taskId) {
    await answer('Bu tapşırıq artıq aktiv deyil.');
    return;
  }

  await answer();

  const questions = ctx.session.checklistQuestions ?? [];
  await beginTaskFlow(ctx, questions, { restarted: true });
}

/** Re-sends the prompt for the step the chat is currently on. */
export async function resumeCurrentStep(ctx: BotContext): Promise<void> {
  switch (ctx.session.step) {
    case 'awaiting_location':
      await beginTaskFlow(ctx, ctx.session.checklistQuestions ?? []);
      return;
    case 'awaiting_checklist':
      await askNextChecklistQuestion(ctx);
      return;
    case 'awaiting_photo':
      await requestShelfPhoto(ctx);
      return;
    case 'awaiting_confirm':
      // The photo is still held, so the confirm prompt can simply be repeated.
      await ctx.reply(
        `📸 *Təsdiq gözləyən şəkil var.*\n\n` +
          `Aşağıdaki düymələrdən istifadə edin: *✅ Təsdiqlə* göndərmək üçün, ` +
          `*🔄 Yenidən çək* isə yeni şəkil üçün.`,
        { parse_mode: 'Markdown', reply_markup: mainMenuInline() },
      );
      return;
    default:
      await ctx.reply(
        `ℹ️ *Hazırda davam edən iş yoxdur.*\n\nTapşırıqları görmək üçün aşağıdaki düyməyə basın.`,
        { parse_mode: 'Markdown', reply_markup: mainMenuInline() },
      );
  }
}
