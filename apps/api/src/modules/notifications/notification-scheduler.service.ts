import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NotificationDispatcherService } from './notification-dispatcher.service';

/**
 * Runs the deadline sweep, which is the only notification trigger that has no
 * event to hang off.
 *
 * WHY A TIMER AND NOT A REQUEST
 * -----------------------------
 * "Fifteen minutes before the deadline" is not something a user does. It is a
 * fact about the clock, so something has to look at the clock. Attaching it to
 * a request would mean the reminder fires only when somebody happens to be using
 * the platform, which is precisely when a reminder is least needed.
 *
 * WHY THE API AND NOT THE BOT
 * ---------------------------
 * The bot cannot run it. `bot_sessions` already documents this for the session
 * sweep: a bot process is restarted on every deploy and there may be two of them
 * for a few seconds, so anything with a timer belongs to the process that is
 * always single and always up. The bot's job is to deliver what is in the
 * outbox; deciding that something belongs in the outbox is the API's.
 *
 * Two API instances would both sweep. That is safe rather than wasteful: the
 * enqueue is deduped by `dedupe_key`, so the second sweep writes nothing.
 *
 * CONFIGURATION
 * -------------
 * `ONETEAM_NOTIFY_SWEEP_MS` — how often to look. The reminder window is fifteen
 * minutes wide, so the default of one minute means a task is reminded about
 * between fourteen and fifteen minutes before its deadline. `0` disables the
 * sweep; an unparseable value falls back to the default rather than silently
 * disabling it, the same rule as `ONETEAM_REFRESH_MS` and
 * `ONETEAM_BOT_SWEEP_MS`.
 */
@Injectable()
export class NotificationSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly dispatcher: NotificationDispatcherService) {}

  onModuleInit(): void {
    const configured = Number(process.env.ONETEAM_NOTIFY_SWEEP_MS);
    const interval = Number.isFinite(configured) && configured >= 0 ? configured : 60_000;

    if (interval === 0) {
      this.logger.warn(
        '⚠️  [NOTIFY] Deadline reminders are OFF (ONETEAM_NOTIFY_SWEEP_MS=0) — ' +
          'a task approaching its deadline will not be reminded about.',
      );
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    // A maintenance timer must not be the thing that keeps the process alive.
    this.timer.unref?.();

    this.logger.log(
      `⏰ [NOTIFY] Deadline sweep every ${Math.round(interval / 1000)}s ` +
        '(15-minute reminder window).',
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One sweep, guarded against overlapping itself and against throwing.
   *
   * A sweep slower than the interval would otherwise stack runs, and each run
   * would re-scan the same tasks. Nothing here may throw out of the timer: an
   * unhandled rejection inside `setInterval` takes the process down, and a
   * failed reminder sweep is not worth a restart — the next tick tries again.
   */
  private async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn(
        '⚠️  [NOTIFY] The previous deadline sweep is still running; skipping this tick.',
      );
      return;
    }

    this.running = true;
    try {
      await this.dispatcher.enqueueDeadlineReminders();
    } catch (error) {
      this.logger.error(
        '⛔ [NOTIFY] Deadline sweep failed: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    } finally {
      this.running = false;
    }
  }
}
