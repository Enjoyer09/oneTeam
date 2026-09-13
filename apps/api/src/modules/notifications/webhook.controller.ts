import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  HttpException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { TelegramWebhookUpdate, TaskState, UserRole } from '@oneteam/types';
import { TaskStateService } from '../tasks/task-state.service';
import { AuthenticatedPrincipal } from '../../common/auth/authenticated-principal';
import { db } from '@oneteam/database';

/** Header Telegram sends when the webhook was registered with a secret token. */
const SECRET_TOKEN_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * Constant-time string comparison.
 *
 * A plain `===` on a secret leaks information through timing: it returns as
 * soon as two characters differ, so an attacker can recover the value one
 * byte at a time. `timingSafeEqual` compares the whole buffer regardless.
 *
 * The length check short-circuits, which does reveal the secret's length. That
 * is acceptable here because Telegram's secret tokens are a fixed, known
 * length — and it avoids `timingSafeEqual` throwing on mismatched buffers.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

@Controller('api/webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly taskStateService: TaskStateService) {}

  /**
   * Handles incoming Telegram webhook updates (inline button callback queries).
   *
   * This endpoint is necessarily unauthenticated in the usual sense — Telegram
   * cannot present a user session. It is instead authenticated by a shared
   * secret that Telegram echoes back in a header, which is why
   * `assertTrustedSender` runs before anything in the body is trusted.
   */
  @Post('telegram')
  @HttpCode(HttpStatus.OK)
  async handleTelegramWebhook(
    @Body() update: TelegramWebhookUpdate,
    @Headers(SECRET_TOKEN_HEADER) secretToken?: string,
  ) {
    // Must come first. Until this passes, the body is attacker-controlled
    // input, and this endpoint can mutate task state and write audit records.
    this.assertTrustedSender(secretToken);

    this.logger.log(`📥 [TELEGRAM WEBHOOK RECEIVED] update_id: ${update.update_id}`);

    // Check for callback query (inline button click)
    const callbackQuery = update.callback_query;
    if (!callbackQuery || !callbackQuery.data) {
      return { ok: true, message: 'No action required' };
    }

    const data = callbackQuery.data;
    const fromUser = callbackQuery.from;

    // Resolve the Telegram account to a real platform user.
    //
    // BUG FIXED HERE: this method used to build the actor as a bare string
    // (`tg_user_${fromUser.id}`) and pass it to `transitionTask`, which
    // requires an `AuthenticatedPrincipal` object. The authorisation layer
    // therefore saw an undefined user and rejected every call with 403 —
    // so acknowledging a task from Telegram could never work, in any
    // environment. The TypeScript compiler reported this
    // (TS2345 at this file), but nothing ran the compiler.
    //
    // Resolving through `getUserByTelegramChatId` also closes an
    // authorisation hole: previously any Telegram account that knew a task id
    // could act on it, because the actor identity was taken from the request
    // body rather than from a trusted mapping.
    const principal = this.resolvePrincipal(fromUser.id);

    if (!principal) {
      this.logger.warn(
        `⛔ [TELEGRAM] Refused callback from unregistered Telegram user ${fromUser.id} (${fromUser.first_name})`,
      );
      throw new HttpException(
        'Bu Telegram hesabı sistemdə qeydiyyatdan keçməyib',
        HttpStatus.FORBIDDEN,
      );
    }

    // Handle "✅ Qəbul Et" (Acknowledge)
    if (data.startsWith('ack_task_')) {
      const taskId = data.replace('ack_task_', '').trim();
      this.logger.log(
        `⚡ [TELEGRAM ACTION: ACKNOWLEDGE] User ${fromUser.first_name} (${fromUser.id}) acknowledges Task ${taskId}`
      );

      const task = db.getTask(taskId);
      if (!task) {
        throw new HttpException(`Tapşırıq tapılmadı: ${taskId}`, HttpStatus.NOT_FOUND);
      }

      // If task is in PUBLISHED state, first mark as DELIVERED, then ACKNOWLEDGED
      if (task.status === TaskState.PUBLISHED) {
        await this.taskStateService.transitionTask(
          taskId,
          TaskState.DELIVERED,
          principal,
          'Avtomatik çatdırılma qeydə alındı'
        );
      }

      // Transition to ACKNOWLEDGED
      const result = await this.taskStateService.transitionTask(
        taskId,
        TaskState.ACKNOWLEDGED,
        principal,
        `Telegram bot üzərindən ${fromUser.first_name} tərəfindən qəbul edildi`
      );

      // Record acknowledgement audit log
      db.logAuditEvent({
        entityType: 'store_task',
        entityId: taskId,
        action: 'TELEGRAM_ACKNOWLEDGED',
        actorId: principal.userId,
        payload: {
          telegramUser: fromUser,
          previousState: result.previousState,
          currentState: result.currentState,
        },
      });

      return {
        ok: true,
        success: true,
        taskId,
        status: TaskState.ACKNOWLEDGED,
        replyMessage:
          `✅ *Tapşırıq Uğurla Qəbul Edildi!*\n\n` +
          `Status: *ACKNOWLEDGED* (İcraya qəbul olundu)\n` +
          `İndi mağazada rəf fotosunu çəkib təsdiqə göndərə bilərsiniz.`,
      };
    }

    return { ok: true, received: true };
  }

  /**
   * Verifies that the request really came from Telegram.
   *
   * WHY THIS EXISTS
   * ---------------
   * Without it, anyone who learns this URL can POST a forged callback. That is
   * not a theoretical concern on this endpoint: a forged callback can move a
   * task through its state machine and write an arbitrary actor into
   * `audit_logs`. An audit trail that a stranger can write to is worse than no
   * audit trail, because it is trusted.
   *
   * FAIL-CLOSED IN PRODUCTION
   * -------------------------
   * If the secret is not configured, production refuses every request rather
   * than accepting unverified ones. "Secure when configured" is how
   * misconfiguration turns into a breach. Outside production the check is
   * skipped with a warning so local development and the test suite stay
   * frictionless.
   *
   * Register the secret when pointing Telegram at this endpoint:
   *
   *     curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
   *          -d "url=https://<host>/api/webhooks/telegram" \
   *          -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
   */
  private assertTrustedSender(provided: string | undefined): void {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;

    if (!expected) {
      if (process.env.NODE_ENV === 'production') {
        this.logger.error(
          '⛔ [TELEGRAM] TELEGRAM_WEBHOOK_SECRET is not set. Refusing the webhook ' +
            'rather than accepting unverified state changes in production.',
        );
        throw new HttpException(
          'Webhook is not configured',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      this.logger.warn(
        '⚠️  [TELEGRAM] TELEGRAM_WEBHOOK_SECRET is not set — sender verification is ' +
          'skipped. This is allowed outside production only.',
      );
      return;
    }

    if (!provided || !safeEqual(provided, expected)) {
      // Deliberately vague to the caller: do not confirm whether the header was
      // absent, malformed, or simply wrong.
      this.logger.warn(
        '⛔ [TELEGRAM] Rejected webhook with a missing or invalid secret token.',
      );
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
  }

  /**
   * Maps a Telegram account to a platform principal.
   *
   * Returns `null` when the Telegram account is not linked to a user, which
   * the caller turns into a 403. Identity must come from this trusted mapping,
   * never from the request body: the body is attacker-controlled, and the
   * audit log records `principal.userId` as the actor.
   */
  private resolvePrincipal(telegramUserId: number | string): AuthenticatedPrincipal | null {
    const user = db.getUserByTelegramChatId(telegramUserId);
    if (!user) return null;
    return {
      userId: user.id,
      role: user.role as UserRole,
      telegramChatId: String(telegramUserId),
    };
  }
}
