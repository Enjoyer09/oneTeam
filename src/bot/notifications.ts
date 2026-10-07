/**
 * oneTeam — the bot's side of the notification outbox
 * ============================================================================
 *
 * WHAT THIS IS FOR
 * ----------------
 * A supervisor creates a task in the panel and the merchandiser it was assigned
 * to is supposed to hear about it. Until now nobody did: the API recorded the
 * intent in an in-memory array inside its own process, logged "DISPATCH
 * COMPLETE", and returned `{ telegram: true }`. Nothing was ever sent, and the
 * array did not survive a deploy.
 *
 * The API now writes a row to `notifications` instead, and this file is the
 * other half: it asks the API for what is waiting, sends it through Telegram,
 * and reports what happened.
 *
 * WHY THE BOT POLLS
 * -----------------
 * Two processes have to cooperate and each holds something the other cannot
 * have. The API can write to the database but must not hold the bot token —
 * one process with the token is one place it can leak from, and a task
 * transition must not be able to fail because Telegram is slow. The bot holds
 * the token and has no database connection, by design.
 *
 * So the API records the intent and the bot asks for it. The alternative — the
 * API calling the bot — needs a second inbound endpoint with its own
 * authentication, and it loses messages whenever the bot is restarting. Polling
 * a table that outlives both processes cannot lose one.
 *
 * THE CLAIM IS WHAT MAKES THAT SAFE
 * ---------------------------------
 * `claimNotifications` leases the rows it returns rather than merely reading
 * them. A deployment starts the new container before stopping the old one, so
 * for a few seconds two bots poll the same table; without the lease both would
 * take the same rows and the merchandiser would get the same message twice. The
 * lease expires, so a bot killed between claiming and sending leaves the row to
 * be picked up again — delivery is at-least-once, which is the right direction
 * for a notification. A duplicate reminder is an annoyance; a lost one is the
 * bug this exists to fix.
 *
 * WHAT IS SENT
 * ------------
 * The `body` the API wrote, verbatim, and NO `parse_mode`. The text is built
 * from a supervisor's free text, and Telegram's legacy Markdown rejects an
 * entire message over a single unmatched `*` or `_` — a task called "Zero_Sugar
 * yoxlaması" would simply never arrive. Plain text cannot fail that way.
 *
 * The only addition is the button, and only when the message is about a task:
 * `open:<taskId>` is the callback the router already answers, so the vocabulary
 * is the one from `callbacks.ts` rather than a second one.
 */

import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import os from 'node:os';
import { encodeCallback } from './callbacks';
import { portalApi } from '../services/portalApi';
import type { BotContext, PendingNotification } from './types';

/** What one pass over the outbox did. Returned so a test can assert on it. */
export interface DrainSummary {
  claimed: number;
  sent: number;
  failed: number;
  deferred: number;
}

/**
 * Decides whether a failed send is worth retrying.
 *
 * The distinction is the difference between a delayed notification and a lost
 * one, and it is not something the lease can work out on its own: a message that
 * fails for a reason a retry cannot fix would be retried forever, and the outbox
 * would fill with rows that never drain.
 *
 *   403 — the person blocked the bot or deleted their account
 *   400 — the chat does not exist, or Telegram refused the message itself
 *
 * Both are terminal: the same request will fail the same way tomorrow.
 *
 * Everything else passes. 429 is a rate limit, 5xx is Telegram having a bad
 * moment, and a network error arrives with no `error_code` at all. For those the
 * right move is to report nothing, leave the claim to expire, and try again.
 */
function describeSendFailure(error: unknown): { terminal: boolean; reason: string } {
  const candidate = error as { error_code?: number; description?: string; message?: string };
  const code = candidate?.error_code;
  const description = candidate?.description ?? candidate?.message ?? String(error);

  if (code === 400 || code === 403) {
    return { terminal: true, reason: `HTTP ${code}: ${description}`.slice(0, 500) };
  }

  return { terminal: false, reason: description };
}

export interface NotificationDrainOptions {
  /** How often to look. `0` disables the loop entirely. */
  pollMs?: number;
  /** How many messages to take per pass. */
  limit?: number;
  /** Identifies this process in the lease, for "who is holding this" questions. */
  claimedBy?: string;
}

export class NotificationDrain {
  private readonly bot: Bot<BotContext>;
  private readonly pollMs: number;
  private readonly limit: number;
  private readonly claimedBy: string;

  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(bot: Bot<BotContext>, options: NotificationDrainOptions = {}) {
    this.bot = bot;
    this.pollMs = options.pollMs ?? readPollMs();
    this.limit = options.limit ?? 20;
    // Names the process holding a lease. Two bot instances overlapping on a
    // deploy both call themselves "bot", so the host and pid are what make the
    // difference visible when a message is stuck claimed.
    this.claimedBy = options.claimedBy ?? `bot@${os.hostname()}:${process.pid}`;
  }

  /**
   * Starts polling.
   *
   * Returns `false` when the loop is switched off, so a caller can say so once
   * at startup instead of leaving a silent absence that looks like a bug the
   * first time somebody is not notified.
   */
  start(): boolean {
    this.stop();

    if (this.pollMs === 0) {
      console.warn(
        '⚠️  [oneTeam Bot] Notification delivery is OFF (ONETEAM_NOTIFY_POLL_MS=0) — ' +
          'messages the API queues will sit in the outbox unsent.',
      );
      return false;
    }

    this.timer = setInterval(() => {
      void this.drainOnce();
    }, this.pollMs);
    // The bot's life is the poll loop for updates, not this timer.
    this.timer.unref?.();

    console.log(
      `📨 [oneTeam Bot] Notification delivery every ${Math.round(this.pollMs / 1000)}s ` +
        `(as ${this.claimedBy}).`,
    );
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Resolves once no pass is in flight.
   *
   * `stop()` cancels future ticks but a pass already running keeps its lease
   * and keeps delivering: a test that stops the loop, inserts a row and drives
   * `drainOnce()` by hand can have that row claimed out from under it by the
   * dying pass. Awaiting this after `stop()` is what makes "the loop is off"
   * mean "nobody is still working".
   */
  async idle(): Promise<void> {
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /**
   * One pass over the outbox.
   *
   * Public so it can be driven directly, which is how the tests exercise the
   * cases that are awkward to provoke through the timer — a blocked chat, a
   * send that fails, a lease that must not be released.
   *
   * Never throws. It runs on a timer nobody awaits, and an unhandled rejection
   * inside `setInterval` takes the process down — a bot that dies because one
   * message could not be delivered is worse than a message that arrives late.
   */
  async drainOnce(): Promise<DrainSummary> {
    const summary: DrainSummary = { claimed: 0, sent: 0, failed: 0, deferred: 0 };

    if (this.running) {
      // A pass slower than the interval would otherwise stack, and every pass
      // would re-claim rows the previous one is still sending.
      console.warn('[oneTeam Bot] The previous notification pass is still running; skipping.');
      return summary;
    }

    this.running = true;
    try {
      let pending: PendingNotification[];
      try {
        pending = await portalApi.claimNotifications({
          limit: this.limit,
          claimedBy: this.claimedBy,
        });
      } catch (error) {
        // Nothing was claimed, so nothing is stranded. The rows are still in the
        // outbox and the next pass will find them.
        console.error(
          '[oneTeam Bot] Could not claim pending notifications:',
          error instanceof Error ? error.message : error,
        );
        return summary;
      }

      summary.claimed = pending.length;

      for (const notification of pending) {
        await this.deliver(notification, summary);
      }

      return summary;
    } finally {
      this.running = false;
    }
  }

  /** Sends one message and reports the outcome. Never throws. */
  private async deliver(notification: PendingNotification, summary: DrainSummary): Promise<void> {
    try {
      await this.send(notification);
    } catch (error) {
      const { terminal, reason } = describeSendFailure(error);

      if (!terminal) {
        // Deliberately not marked. The claim expires and the message comes back,
        // which is the only reason a notification survives Telegram being down.
        summary.deferred += 1;
        console.warn(
          `⏳ [oneTeam Bot] Notification ${notification.id} could not be sent and will be ` +
            `retried after its lease expires: ${reason}`,
        );
        return;
      }

      summary.failed += 1;
      console.error(
        `⛔ [oneTeam Bot] Notification ${notification.id} was refused by Telegram and will ` +
          `not be retried: ${reason}`,
      );
      try {
        await portalApi.markNotificationFailed(notification.id, reason);
      } catch (markError) {
        // The row keeps its lease and will be retried, which is the safe
        // direction: the alternative is a row that says "failed" while the
        // reason for it was never written.
        console.error(
          `[oneTeam Bot] Could not record the failure of notification ${notification.id}:`,
          markError instanceof Error ? markError.message : markError,
        );
      }
      return;
    }

    summary.sent += 1;

    try {
      const marked = await portalApi.markNotificationDelivered(notification.id);
      if (!marked) {
        // The message went out but the record did not take. It will be sent
        // again when the lease expires. Said out loud rather than swallowed,
        // because a duplicate message is confusing and the reason for it should
        // not be a mystery.
        console.warn(
          `⚠️  [oneTeam Bot] Notification ${notification.id} was delivered but could not be ` +
            'marked as such; the chat may receive it a second time.',
        );
      }
    } catch (error) {
      console.error(
        `[oneTeam Bot] Could not mark notification ${notification.id} as delivered:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * The Telegram call.
   *
   * `sendMessage` on `bot.api` rather than a hand-rolled `fetch`, so the request
   * goes through the same client the rest of the bot uses — which is also what
   * lets the test suite intercept it.
   */
  private async send(notification: PendingNotification): Promise<void> {
    const keyboard = notification.taskId
      ? new InlineKeyboard().text('🔓 Tapşırığı aç', encodeCallback('open', notification.taskId))
      : undefined;

    await this.bot.api.sendMessage(notification.chatId, notification.body, {
      reply_markup: keyboard,
    });
  }
}

/**
 * `ONETEAM_NOTIFY_POLL_MS` — how often the outbox is checked.
 *
 * Five seconds is the balance this bot already strikes elsewhere: fast enough
 * that a merchandiser who was just assigned a task sees it while they are still
 * holding the phone, slow enough that an idle bot is not making three hundred
 * API calls a minute for nothing.
 *
 * `0` is an explicit opt-out. An unparseable value falls back to the default
 * rather than silently disabling delivery, which is the same rule
 * `ONETEAM_REFRESH_MS` and `ONETEAM_BOT_SWEEP_MS` follow — a typo must not look
 * like a decision.
 */
function readPollMs(): number {
  const configured = Number(process.env.ONETEAM_NOTIFY_POLL_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 5_000;
}
