import { Injectable, Logger } from '@nestjs/common';
import { NotificationOutcome, StoreTask, TaskPriority } from '@oneteam/types';
import { db } from '@oneteam/database';

/**
 * Records the intent to notify somebody, in the outbox the bot drains.
 *
 * WHAT THIS SERVICE USED TO BE
 * ----------------------------
 * It was named the same and did nothing of the sort. `dispatchTaskPublished`
 * built a `TelegramNotificationPayload`, pushed it onto a public array named
 * `dispatchedTelegramMessages`, built an APNs payload for a mobile client that
 * has no push permission and no device registration, pushed that onto a second
 * array, wrote an audit event, logged `[DISPATCH COMPLETE]`, and returned
 * `{ telegram: true, pushNotification: true }`. Nothing left the process. The
 * arrays were emptied by every deploy, and the chat id was not a chat id — it
 * was `task.assignedUserId`, a platform user id, falling back to the literal
 * `'998877665'` when the task had no assignee at all. The message body was
 * hardcoded prose about Classic Beverage, Zero Sugar and Orange Soda, so a task
 * about anything else was announced with the wrong instructions.
 *
 * WHY THE API DOES NOT TALK TO TELEGRAM
 * -------------------------------------
 * `TELEGRAM_BOT_TOKEN` is held by exactly one process, the bot. If the API also
 * sent messages, the token would exist in two places and a task creation would
 * fail whenever Telegram was slow or unreachable — coupling a database write to
 * a third party. So the API records the intent and the bot performs the send.
 * This is the same shape as `bot_sessions`: the API owns the data, the bot
 * reaches it only through the API.
 *
 * WHAT "QUEUED" HONESTLY MEANS
 * ----------------------------
 * Every method here returns a `NotificationOutcome`, and none of them claims a
 * message was delivered. The API cannot know that; delivery happens later, on
 * the bot's clock, and is observable from the outbox. `queued` means a row
 * exists. It does not mean anyone has read anything.
 *
 * THE BODIES ARE PLAIN TEXT, ON PURPOSE
 * -------------------------------------
 * Not Markdown, and the bot sends them without `parse_mode`. A template title
 * is free text typed by a supervisor, and in Telegram's legacy Markdown an
 * unmatched `*` or `_` makes the whole message fail to parse — the API returns
 * 400 and the message is never delivered. That is the exact failure this phase
 * exists to remove, and no amount of escaping is as safe as not having the
 * problem. Emoji and line breaks need no markup.
 */
@Injectable()
export class NotificationDispatcherService {
  private readonly logger = new Logger(NotificationDispatcherService.name);

  /**
   * Records "this task is now yours" for the merchandiser it was assigned to.
   *
   * Called on PUBLISHED, which is the moment a store task starts existing as
   * work. Idempotent through `dedupeKey`: publishing the same task twice — a
   * retried request, or a second bot instance — cannot enqueue two messages.
   */
  async dispatchTaskPublished(task: StoreTask): Promise<NotificationOutcome> {
    const store = db.getStore(task.storeId);
    const template = db.getTemplate(task.templateId);

    const lines: string[] = ['📋 Yeni tapşırıq', ''];
    if (store) {
      lines.push(`🏪 Mağaza: ${store.name} (${store.storeCode})`);
    }
    if (template) {
      lines.push(`📝 Tapşırıq: ${template.title}`);
      lines.push(`⚡ Prioritet: ${priorityLabel(template.priority)}`);
    }
    lines.push(`⏰ Son tarix: ${formatDeadline(task.deadline)}`);
    lines.push('');
    lines.push('Tapşırığa baxmaq üçün aşağıdakı düyməni sıxın.');

    // A store or template that cannot be read is left out rather than replaced
    // with a placeholder. `Tərəfdaş Mağaza` was the old fallback: a merchandiser
    // who saw it would have no way to tell which shop the task was for, and the
    // supervisor would never learn that the lookup failed.
    if (!store || !template) {
      this.logger.warn(
        `⚠️  [NOTIFY] Task ${task.id} is missing its ` +
          `${[!store && `store (${task.storeId})`, !template && `template (${task.templateId})`]
            .filter(Boolean)
            .join(' and ')}; the message was built from what could be read.`,
      );
    }

    return this.enqueue({
      kind: 'TASK_ASSIGNED',
      task,
      title: store ? `Yeni tapşırıq — ${store.name}` : `Yeni tapşırıq — ${task.id}`,
      body: lines.join('\n'),
      dedupeKey: `TASK_ASSIGNED:${task.id}`,
    });
  }

  /**
   * Records "your photo was rejected, here is why" for the merchandiser.
   *
   * The dedupe key is the *evidence* id, not the task id: a task can be
   * rejected more than once (`REJECTED → IN_PROGRESS → SUBMITTED → REJECTED` is
   * a legal path), and each rejection is about a different photo. Keying on the
   * task would send the first rejection and silently swallow every later one.
   */
  async dispatchTaskRejected(
    task: StoreTask,
    evidenceId: string,
    feedback: string,
  ): Promise<NotificationOutcome> {
    const store = db.getStore(task.storeId);

    const lines: string[] = ['❌ Foto rədd edildi', ''];
    if (store) {
      lines.push(`🏪 Mağaza: ${store.name} (${store.storeCode})`);
    }
    if (feedback.trim()) {
      lines.push('');
      lines.push(`📝 Səbəb: ${feedback.trim()}`);
    }
    lines.push('');
    lines.push('Yenidən çəkib təkrar təqdim edə bilərsiniz.');

    return this.enqueue({
      kind: 'TASK_REJECTED',
      task,
      title: store ? `Foto rədd edildi — ${store.name}` : `Foto rədd edildi — ${task.id}`,
      body: lines.join('\n'),
      dedupeKey: `TASK_REJECTED:${evidenceId}`,
    });
  }

  /**
   * Records a reminder for every task whose deadline falls inside the window.
   *
   * Runs on a timer from `NotificationSchedulerService`, so it is written to be
   * cheap and to say what it did. The scan is over the in-memory replica rather
   * than a query: the window is fifteen minutes wide, the replica lags the
   * database by about a second, and a task that enters the window between two
   * ticks is caught by the next tick. A reminder a few seconds late is not a
   * defect; a query per tick over every task would be.
   *
   * `dedupeKey` is what makes a repeating sweep safe. Without it this method
   * would enqueue the same reminder on every tick for fifteen minutes.
   */
  async enqueueDeadlineReminders(withinMinutes = 15): Promise<NotificationSummary> {
    const now = Date.now();
    const windowEnd = now + withinMinutes * 60_000;

    const summary: NotificationSummary = {
      queued: 0,
      alreadyQueued: 0,
      withoutRecipient: 0,
      noQueue: 0,
      scanned: 0,
    };

    if (!db.hasDatabase) {
      // No outbox to write to. Reporting zeroes without saying why would make a
      // process running on seed data look like a process with nothing to send.
      this.logger.warn('⚠️  [NOTIFY] Deadline sweep skipped: no database connection.');
      return summary;
    }

    for (const task of db.storeTasks) {
      if (!isActionable(task.status)) continue;

      const deadline = new Date(task.deadline).getTime();
      if (Number.isNaN(deadline)) continue;
      // Only the run-up to the deadline. A task that is already overdue is not
      // something this reminder can help with, and reminding on every tick
      // forever is how a notification becomes noise that gets muted.
      if (deadline <= now || deadline > windowEnd) continue;

      summary.scanned += 1;

      const store = db.getStore(task.storeId);
      const minutesLeft = Math.max(1, Math.round((deadline - now) / 60_000));

      const lines: string[] = [`⏰ Son tarixə ${minutesLeft} dəqiqə qaldı`, ''];
      if (store) {
        lines.push(`🏪 Mağaza: ${store.name} (${store.storeCode})`);
      }
      lines.push(`⏰ Son tarix: ${formatDeadline(task.deadline)}`);
      lines.push('');
      lines.push('Tapşırığı tamamlayıb foto göndərməyi unutmayın.');

      const outcome = await this.enqueue({
        kind: 'DEADLINE_SOON',
        task: task as unknown as StoreTask,
        title: store ? `Son tarix yaxınlaşır — ${store.name}` : `Son tarix yaxınlaşır — ${task.id}`,
        body: lines.join('\n'),
        dedupeKey: `DEADLINE_SOON:${task.id}`,
      });

      countOutcome(summary, outcome);
    }

    if (summary.queued > 0 || summary.withoutRecipient > 0) {
      this.logger.log(
        `⏰ [NOTIFY] Deadline sweep: ${summary.scanned} task(s) inside the ${withinMinutes}-minute ` +
          `window — ${summary.queued} queued, ${summary.alreadyQueued} already queued, ` +
          `${summary.withoutRecipient} with no destination.`,
      );
    }

    return summary;
  }

  /**
   * Writes one row to the outbox, and reports which of the four cases it hit.
   *
   * The `chat_id` is resolved here, at enqueue time, and may be null. Null is
   * not an error and the row is not dropped: it records that this person was
   * supposed to be told and could not be, because they have never spoken to the
   * bot. Dropping it would leave the supervisor's "queued" count honest but the
   * reason for the missing message invisible.
   *
   * Such a row is never claimable — `claimNotifications` requires a non-null
   * chat id — so it is a record, not a pending message. The deadline reminder
   * resolves the chat id again when it runs, so a merchandiser who enrols in
   * the bot after being assigned still gets the reminder.
   */
  private async enqueue(params: {
    kind: 'TASK_ASSIGNED' | 'TASK_REJECTED' | 'DEADLINE_SOON';
    task: StoreTask;
    title: string;
    body: string;
    dedupeKey: string;
  }): Promise<NotificationOutcome> {
    if (!db.hasDatabase) {
      // Distinguishing this from "already queued" is the whole reason the
      // facade exposes `hasDatabase`: both look like a null row from here, and
      // reporting "queued" for a process with no queue would be the same class
      // of lie this service was written to remove.
      this.logger.warn(
        `⚠️  [NOTIFY] ${params.kind} for task ${params.task.id} was not recorded: ` +
          'no database connection, so there is no outbox.',
      );
      return 'no-queue';
    }

    const userId = params.task.assignedUserId ?? null;
    const chatId = this.resolveChatId(userId);

    const row = await db.enqueueNotification({
      kind: params.kind,
      chatId,
      userId,
      storeTaskId: params.task.id,
      title: params.title,
      body: params.body,
      payload: { taskId: params.task.id, storeId: params.task.storeId, kind: params.kind },
      dedupeKey: params.dedupeKey,
    });

    if (!row) {
      return 'already-queued';
    }

    if (!chatId) {
      this.logger.warn(
        `⚠️  [NOTIFY] ${params.kind} for task ${params.task.id} is recorded but has nowhere to go: ` +
          (userId
            ? `user ${userId} has never spoken to the bot, so no chat id is known.`
            : 'the task has no assignee.'),
      );
      return 'no-recipient';
    }

    this.logger.log(
      `📨 [NOTIFY] ${params.kind} for task ${params.task.id} queued for chat ${chatId} (${params.dedupeKey}).`,
    );
    return 'queued';
  }

  /**
   * The Telegram chat a user's messages must reach, or null when there is none.
   *
   * `telegramChatId` is written when the user talks to the bot, so a user who
   * has never opened it has none — and a platform user id is not a substitute.
   * The code this replaces used one as the other.
   */
  private resolveChatId(userId: string | null): string | null {
    if (!userId) return null;
    const user = db.getUser(userId);
    const chatId = user?.telegramChatId;
    return chatId ? String(chatId) : null;
  }
}

/** Per-sweep counts. Mirrors `NotificationDispatchSummary` plus the sweep's own scan count. */
export interface NotificationSummary {
  queued: number;
  alreadyQueued: number;
  withoutRecipient: number;
  noQueue: number;
  scanned: number;
}

function countOutcome(summary: NotificationSummary, outcome: NotificationOutcome): void {
  if (outcome === 'queued') summary.queued += 1;
  else if (outcome === 'already-queued') summary.alreadyQueued += 1;
  else if (outcome === 'no-recipient') summary.withoutRecipient += 1;
  else summary.noQueue += 1;
}

/**
 * Whether a task in this state is still the merchandiser's to act on.
 *
 * The states that are excluded are the ones where a reminder would be wrong:
 * DRAFT has not been published, SUBMITTED is waiting on the supervisor, and
 * APPROVED is finished. REJECTED is included on purpose — it is the
 * merchandiser who has to redo the work, which is exactly who needs reminding.
 */
function isActionable(status: string): boolean {
  return ['PUBLISHED', 'DELIVERED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'REJECTED'].includes(status);
}

/**
 * The priority in the words a merchandiser reads.
 *
 * Takes a plain `string` because that is what a template's `priority` actually
 * is once it has been through the database replica and the seed data — the
 * column is text, and typing the parameter as the enum would have the compiler
 * assert something the storage does not guarantee. An unrecognised value is
 * reported as "Göstərilməyib" rather than guessed at.
 */
function priorityLabel(priority: string | undefined): string {
  switch (priority) {
    case TaskPriority.URGENT:
      return 'Təcili';
    case TaskPriority.HIGH:
      return 'Yüksək';
    case TaskPriority.LOW:
      return 'Aşağı';
    case TaskPriority.MEDIUM:
      return 'Orta';
    default:
      return 'Göstərilməyib';
  }
}

/**
 * The deadline in Baku time, because that is where the shelves are.
 *
 * Returns a sentence rather than `Invalid Date` when the value cannot be read:
 * a notification whose only content is a broken date is worse than one that
 * says the date is unknown.
 */
function formatDeadline(deadline: Date | string): string {
  const date = new Date(deadline);
  if (Number.isNaN(date.getTime())) return 'göstərilməyib';

  return new Intl.DateTimeFormat('az-AZ', {
    timeZone: 'Asia/Baku',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
