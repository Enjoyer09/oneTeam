/**
 * oneTeam Telegram Bot — the day at a glance
 * ============================================================================
 *
 * WHAT THIS SCREEN IS FOR
 * -----------------------
 * `/tasks` answers "what work is open?" and `/mystatus` answers "what happened
 * to what I sent?". Neither answers the question a merchandiser actually opens
 * the bot with at the start of a shift: "what is on me *today*, and what have I
 * already done today?". Answering that meant opening both screens and doing the
 * arithmetic in your head.
 *
 * So this is one message that says both, scoped to today: how many tasks are
 * still open for the store, and which audits were filed today with their review
 * status. It is the new home button (`🗓 Bugün`), the `/bugun` command, and the
 * `today:me` inline action — all of which land here.
 *
 * NO NEW API
 * ----------
 * It reads nothing the bot could not already read: the store's open tasks and
 * this chat's recent submissions. "Today" is computed here, in the store's
 * timezone (Asia/Baku), rather than asked of the API — the API has no
 * day-scoped endpoint and adding one to render a summary would be weight the
 * feature does not need.
 *
 * WHY IT STILL SENDS THE TASK BUTTONS SEPARATELY
 * ----------------------------------------------
 * A Telegram message carries exactly one `reply_markup`. The overview has to
 * carry the reply keyboard — it answers a typed command / durable button, and
 * that keyboard is the way back (see `keyboards.ts`). One-tap `open:` buttons
 * are inline, so they cannot ride the same message. Rather than drop either,
 * the overview restores the reply keyboard and a short follow-up carries the
 * inline shortcuts — the same two-message shape `/tasks` already uses.
 */

import { clock } from '@oneteam/types';
import { InlineKeyboard } from 'grammy';
import { BotContext, SubmissionRecord, TaskRecord } from '../types';
import { portalApi, PortalApiError } from '../../services/portalApi';
import { encodeCallback } from '../callbacks';
import { mainMenuKeyboard } from '../keyboards';
import { escapeMarkdown } from '../markdown';

/** How many one-tap task shortcuts to show before falling back to the full list. */
const MAX_TASK_SHORTCUTS = 6;

const STATUS_ICONS: Record<string, string> = {
  pending_review: '⏳',
  approved: '✅',
  rejected: '❌',
};

/**
 * Is an ISO timestamp "today" in the store's timezone?
 *
 * Compared as rendered calendar dates in Asia/Baku, not as a 24-hour window:
 * "today" to a merchandiser is the date on the wall, and a submission filed at
 * 00:30 is today's even though it is minutes old. `sv-SE` is used only because
 * it renders a sortable `YYYY-MM-DD`, which makes the comparison a string
 * equality rather than three field reads.
 */
function isToday(iso: string, now: Date = clock.now()): boolean {
  const opts: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Baku' };
  try {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return false;
    return then.toLocaleDateString('sv-SE', opts) === now.toLocaleDateString('sv-SE', opts);
  } catch {
    return false;
  }
}

/**
 * `/bugun`, the "🗓 Bugün" button, and the `today:me` inline action.
 *
 * Carries the reply keyboard on the overview for the same reason every
 * command-answering message does: it is the way back to the menu after the
 * location step's one-time keyboard has dismissed it.
 */
export async function handleToday(ctx: BotContext): Promise<void> {
  if (!ctx.session.storeId) {
    await ctx.reply(
      `⚠️ *Mağaza qeydiyyatı tapılmadı!*\n\nZəhmət olmasa əvvəlcə /start əmrini göndərib mağaza kodunuzu daxil edin.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const chatId = ctx.chat?.id;

  let tasks: TaskRecord[];
  let submissions: SubmissionRecord[];
  try {
    // Read in parallel: the two calls are independent and this screen is opened
    // often, so the round trips should overlap rather than queue.
    [tasks, submissions] = await Promise.all([
      portalApi.getTasksForStore(ctx.session.storeId),
      chatId ? portalApi.getSubmissionsByChatId(chatId, 20) : Promise.resolve([]),
    ]);
  } catch (error) {
    const detail = error instanceof PortalApiError ? error.message : String(error);
    console.error(`[oneTeam Bot] "Bugün" lookup failed for ${ctx.session.storeId}:`, detail);
    await ctx.reply(
      `❌ *Bugünkü məlumatı yükləmək mümkün olmadı.*\n\nZəhmət olmasa bir az sonra yenidən cəhd edin.`,
      { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() },
    );
    return;
  }

  const todays = submissions.filter((s) => isToday(s.submitted_at));

  const dateStr = clock.now().toLocaleDateString('az-AZ', {
    timeZone: 'Asia/Baku',
    weekday: 'long',
    day: '2-digit',
    month: 'long',
  });

  // The active-tasks line. Zero is said plainly rather than hidden, because "no
  // open tasks" is a real and reassuring answer at the end of a shift.
  const tasksLine =
    tasks.length > 0
      ? `📋 *Açıq tapşırıq:* ${tasks.length}`
      : `📋 *Açıq tapşırıq yoxdur* — bu gün üçün hər şey təmizdir. ✅`;

  // The submitted-today block. Counts by review status so a merchandiser can see
  // at a glance whether anything came back rejected without opening /mystatus.
  let submittedBlock: string;
  if (todays.length === 0) {
    submittedBlock = `📸 *Bu gün göndərilən şəkil yoxdur.*`;
  } else {
    const approved = todays.filter((s) => s.status === 'approved').length;
    const pending = todays.filter((s) => s.status === 'pending_review').length;
    const rejected = todays.filter((s) => s.status === 'rejected').length;

    const parts: string[] = [];
    if (approved) parts.push(`✅ ${approved}`);
    if (pending) parts.push(`⏳ ${pending}`);
    if (rejected) parts.push(`❌ ${rejected}`);

    let block = `📸 *Son 20 qeyddə bu gün:* ${todays.length}  (${parts.join('  ')})\n`;
    if (submissions.length === 20) {
      block += `_Dəqiq ümumi say üçün Auditlərim bölməsinə baxın._\n`;
    }
    for (const sub of todays.slice(0, 5)) {
      const icon = STATUS_ICONS[sub.status] ?? '•';
      const title = sub.task?.title ?? 'Rəf yoxlanışı';
      block += `   ${icon} ${escapeMarkdown(title)}\n`;
    }
    // A rejected audit is the one thing worth nudging on: it needs re-shooting.
    if (rejected > 0) {
      block += `\n⚠️ İmtina edilən audit(lər) var — /mystatus ilə səbəbə baxıb yenidən göndərin.`;
    }
    submittedBlock = block.trimEnd();
  }

  const overview =
    `🗓 *Bugün — ${escapeMarkdown(ctx.session.storeName ?? 'Mağaza')}*\n` +
    `_${dateStr}_\n\n` +
    `${tasksLine}\n\n` +
    `${submittedBlock}`;

  await ctx.reply(overview, {
    parse_mode: 'Markdown',
    reply_markup: mainMenuKeyboard(),
  });

  // The one-tap shortcuts, only when there is something to tap. Each is the same
  // `open:` action a task card carries, so tapping one starts the guided flow
  // exactly as opening it from /tasks would.
  if (tasks.length === 0) return;

  const shown = tasks.slice(0, MAX_TASK_SHORTCUTS);
  const keyboard = new InlineKeyboard();
  for (const task of shown) {
    keyboard.text(`📸 ${task.title}`, encodeCallback('open', task.id)).row();
  }
  if (tasks.length > MAX_TASK_SHORTCUTS) {
    keyboard.text('📋 Bütün tapşırıqlar', encodeCallback('tasks', 'list')).row();
  }

  await ctx.reply(`⚡ *Sürətli keçid* — tapşırığa toxunub başlayın:`, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
}
