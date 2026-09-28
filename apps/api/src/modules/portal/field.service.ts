/**
 * oneTeam — Field API (Telegram bot)
 * ============================================================================
 *
 * The bot's data layer, served from the API instead of from Supabase.
 *
 * WHY THE SHAPES ARE THE PANEL'S
 * ------------------------------
 * The bot and the panel read the same things — a store by code, the tasks for
 * that store, the audits that came back — so these endpoints return the same
 * shapes the portal does. One mapping, two consumers, and a store that looks
 * different in the bot than in the panel becomes impossible rather than merely
 * unlikely.
 *
 * WHO IS ACTING
 * -------------
 * The bot authenticates with one service credential, because it is a server and
 * one process serves every chat. The acting user therefore arrives as a
 * `chatId` parameter and is resolved to a user row here.
 *
 * That is only safe because the service credential is not reachable by a chat:
 * a Telegram user cannot call these endpoints, they can only ask the bot to.
 * The bot must never forward a caller-supplied chat id it has not derived from
 * the update it is handling — that would let one user read another's audits.
 *
 * EVIDENCE SUBMISSION IS DELEGATED, NOT REIMPLEMENTED
 * ---------------------------------------------------
 * `EvidenceService` already owns the geofence check, the dynamic checklist
 * validation and the before/after photo pipeline. This service resolves who is
 * acting and then calls it, so the anti-fraud rules cannot drift between the
 * bot and the mobile client.
 */

import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import {
  TaskState,
  UserRole,
  BOT_STEPS,
  BotStep,
  isBotStep,
  ChecklistAnswer,
  ChecklistQuestion,
  FieldFlowPayload,
} from '@oneteam/types';
import {
  db,
  type BotSessionRow,
  type NotificationRow as BotNotificationRow,
} from '@oneteam/database';
import { PortalService, PanelStore, PanelTask, PanelSubmission } from './portal.service';
import { EvidenceService } from '../evidences/evidence.service';
import { TaskStateService } from '../tasks/task-state.service';
import { StorageService } from '../storage/storage.service';
import { AuthenticatedPrincipal } from '../../common/auth/authenticated-principal';

/** Largest photo accepted as a data URL. See the note in submitSubmission. */
const MAX_PHOTO_BYTES = 1_500_000;

/**
 * The floor an AI verdict must clear to be auto-approved without a human.
 *
 * Chosen by the operator ("auto-approve high confidence"). It is deliberately
 * higher than the rule-based auto-approver's 70: a machine approving a shelf
 * with no human in the loop should be *sure*, and the cost of being wrong here
 * is an unearned pass, whereas the cost of being cautious is only a supervisor
 * glance. Everything below this — or any unsure verdict — waits for a human.
 */
const AI_AUTO_APPROVE_MIN_SCORE = 85;

/**
 * Who the API acts as when it auto-approves on the vision engine's behalf.
 *
 * A synthetic SUPERVISOR: `reviewSubmission` refuses anyone who is not a
 * reviewer, and the merchandiser the bot speaks for is not one (they may not
 * approve their own audit). This principal never authenticates a request — it
 * exists only inside this process to name the actor on the state change, so the
 * audit trail reads "system-ai-vision" rather than a real person for a decision
 * no person made. `via: 'service'` matches how the trusted server acts.
 */
const AI_REVIEWER_PRINCIPAL: AuthenticatedPrincipal = {
  userId: 'system-ai-vision',
  role: UserRole.SUPERVISOR,
  via: 'service',
};

/**
 * How a channel names the person who is acting.
 *
 * The bot is one server serving every chat, so it identifies the acting person
 * by the Telegram chat the update arrived from. The mobile client is a device,
 * so it identifies them by the installation it was bound on.
 *
 * Both resolve to the same user row, and that is the point: the anti-fraud rules
 * (`canUserAccessTask`, the geofence, the checklist) are written against the
 * *user*, so neither channel needs its own copy of them and the two cannot drift.
 *
 * The key is not a credential. The caller still has to hold the service
 * credential to reach these endpoints at all, which is why a device id can be
 * trusted to name a person but never to authenticate one.
 */
export interface FieldActorKey {
  chatId?: string | number;
  deviceId?: string;
}

@Injectable()
export class FieldService {
  private readonly logger = new Logger(FieldService.name);

  constructor(
    private readonly portal: PortalService,
    private readonly evidenceService: EvidenceService,
    private readonly taskStateService: TaskStateService,
    private readonly storage: StorageService,
  ) {}

  private toPrincipal(user: {
    id: string;
    role: string;
    telegramChatId?: string | null;
  }): AuthenticatedPrincipal {
    return {
      userId: user.id,
      role: user.role as UserRole,
      telegramChatId: user.telegramChatId ?? null,
    };
  }

  /**
   * Resolves a channel key to a user row, or null when it has never bound.
   *
   * `chatId` is checked first so a caller that sends both gets the chat identity
   * — the more specific of the two, and the one a bug is less likely to have
   * invented.
   */
  private resolveActor(key: FieldActorKey): AuthenticatedPrincipal | null {
    if (key.chatId !== undefined && key.chatId !== null && key.chatId !== '') {
      const user = db.getUserByTelegramChatId(key.chatId);
      return user ? this.toPrincipal(user) : null;
    }

    if (key.deviceId) {
      const user = db.getUserByMobileDeviceId(key.deviceId);
      return user ? this.toPrincipal(user) : null;
    }

    return null;
  }

  private requireActor(key: FieldActorKey): AuthenticatedPrincipal {
    const actor = this.resolveActor(key);
    if (actor) return actor;

    // Named per channel: "your chat is not registered" and "your device is not
    // registered" send the person to different remedies, so collapsing them into
    // one message would leave half of them with the wrong instructions.
    const isChat = key.chatId !== undefined && key.chatId !== null && key.chatId !== '';
    throw new HttpException(
      {
        error: isChat ? 'UNBOUND_CHAT' : 'UNBOUND_DEVICE',
        message: isChat
          ? 'Bu Telegram hesabı heç bir istifadəçiyə bağlanmayıb. /start əmri ilə mağaza kodunu göndərin.'
          : 'Bu cihaz heç bir istifadəçiyə bağlanmayıb. Tətbiqdən yenidən daxil olun.',
      },
      HttpStatus.NOT_FOUND,
    );
  }

  // -------------------------------------------------------------------------
  // Binding
  // -------------------------------------------------------------------------

  /**
   * Binds a chat to a user, creating the user on first contact.
   *
   * The bot calls this from /start and after a successful store-code check, so
   * the identity exists before any audit is submitted.
   *
   * WHY A STORE CODE ALSO ASSIGNS WORK
   * ----------------------------------
   * `EvidenceService` refuses a submission when the acting MERCHANDISER is not
   * the task's assignee — that check is what stops one field worker filing an
   * audit against another's store. The panel satisfies it because a supervisor
   * chooses the assignee at dispatch time.
   *
   * A chat has no supervisor. The store code is the only thing the merchandiser
   * has, and it is the claim: whoever knows it is standing in that store. So
   * binding to a store also claims that store's unassigned open tasks, which is
   * what makes a submission from the bot possible at all.
   *
   * A task that already belongs to someone else is left alone. Reassigning it
   * silently would let any chat take over another merchandiser's work just by
   * knowing the store code — a supervisor has to do that deliberately.
   *
   * The claim is written to the audit log (`TASK_SELF_ASSIGNED`) rather than
   * happening invisibly, because "who claimed this store" is exactly the kind of
   * thing that should be answerable later.
   *
   * BOTH CHANNELS BIND THE SAME WAY, WHICH IS THE POINT.
   *
   * The mobile client has no supervisor either — it is a device in a shop, and
   * the store code is the only thing the person using it has. Giving the two
   * channels different claiming rules would mean an audit could be legitimate on
   * one and impossible on the other, and the rule would have to be maintained
   * twice.
   */
  bind(key: FieldActorKey, fullName: string, storeId?: string) {
    const hasChatId = key.chatId !== undefined && key.chatId !== null && key.chatId !== '';

    const result = hasChatId
      ? db.bindTelegramUser({ telegramChatId: key.chatId as string | number, fullName })
      : key.deviceId
        ? db.bindDeviceUser({ deviceId: key.deviceId, fullName })
        : null;

    if (!result) {
      throw new HttpException(
        {
          error: 'MISSING_ACTOR_KEY',
          message: 'chatId və ya deviceId tələb olunur',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const channel: 'telegram' | 'mobile' = hasChatId ? 'telegram' : 'mobile';
    const externalId = hasChatId ? String(key.chatId) : String(key.deviceId);

    this.logger.log(`🔗 [FIELD BIND] ${channel} ${externalId} -> ${result.id} (${result.role})`);

    const claimed = this.claimStoreTasks(result.id, storeId, channel);

    return { success: true, data: { ...result, claimedTaskIds: claimed } };
  }

  /**
   * Claims a store's unassigned open work for a user.
   *
   * Shared by both channels so the rule — claim what is free, never take over
   * what belongs to someone else — exists once. Extracted from `bind` for that
   * reason and not for brevity.
   */
  private claimStoreTasks(
    userId: string,
    storeId: string | undefined,
    channel: 'telegram' | 'mobile',
  ): string[] {
    if (!storeId) return [];

    const open = new Set(['PUBLISHED', 'DELIVERED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'SUBMITTED']);

    const claimable = db.storeTasks.filter(
      (task) =>
        task.storeId === storeId &&
        open.has(task.status) &&
        (!task.assignedUserId || task.assignedUserId === userId),
    );

    const claimed: string[] = [];
    for (const task of claimable) {
      db.assignStoreTask(task.id, userId);
      claimed.push(task.id);
    }

    if (claimed.length > 0) {
      db.logAuditEvent({
        entityType: 'store_task',
        entityId: storeId,
        action: 'TASK_SELF_ASSIGNED',
        actorId: userId,
        payload: {
          channel,
          storeId,
          taskIds: claimed,
          reason:
            'Mağaza kodu ilə qeydiyyat: işçi bu mağazanın açıq tapşırıqlarını öz üzərinə götürdü.',
        },
      });
      this.logger.log(
        `📌 [FIELD CLAIM] ${userId} claimed ${claimed.length} task(s) at store ${storeId} (${channel})`,
      );
    }

    return claimed;
  }

  session(key: FieldActorKey) {
    const user =
      key.chatId !== undefined && key.chatId !== null && key.chatId !== ''
        ? db.getUserByTelegramChatId(key.chatId)
        : key.deviceId
          ? db.getUserByMobileDeviceId(key.deviceId)
          : null;

    if (!user) return { success: true, data: null };
    return {
      success: true,
      data: {
        userId: user.id,
        fullName: user.fullName,
        role: user.role,
      },
    };
  }

  // -------------------------------------------------------------------------
  // The guided flow's position — see `bot_sessions`
  // -------------------------------------------------------------------------

  /**
   * Reads a chat's place in the guided flow, or null when there is none to
   * resume.
   *
   * WHY THIS IS SEPARATE FROM `session()` ABOVE
   * -------------------------------------------
   * `session()` answers "who is this chat" out of the `users` table, and the bot
   * calls it on start-up to find out whether the chat is already bound. This
   * answers "where were we in the audit". One is an identity, the other is a
   * position; they have different lifetimes (a person lasts for years, a
   * half-finished checklist lasts fifteen minutes) and merging them would mean
   * expiring the binding along with the flow.
   *
   * The read also refreshes the expiry — see `readBotSession`. That is why a
   * merchandiser who is using the bot never loses their store, while one who
   * walked away an hour ago does.
   */
  async readFlow(key: FieldActorKey) {
    const chatId = String(key.chatId);

    try {
      const row = await db.readBotSession(chatId);
      return { success: true, data: row ? this.toFlowPayload(row) : null };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`⛔ [FLOW] Could not read the flow for chat ${chatId}: ${detail}`);
      // 503 rather than an empty session, on purpose. An empty session tells the
      // bot "this chat has never started", and the bot would answer by asking a
      // merchandiser standing in a shop to type their store code again — losing
      // work that is still in the database. A temporary failure has to look like
      // one.
      throw new HttpException(
        {
          error: 'FLOW_UNAVAILABLE',
          message:
            'Tapşırıq axını oxuna bilmədi. Zəhmət olmasa bir az sonra yenidən cəhd edin — ' +
            'davam edən işiniz itməyib.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /**
   * Writes a chat's whole place in the flow.
   *
   * Validated here rather than trusted, because this is the one endpoint the bot
   * writes on every button tap and a malformed session is not a visible error —
   * it is a flow that resumes in a state the bot cannot act on, which reads to
   * the merchandiser as the bot having lost their work.
   *
   * `user_id` is resolved here from the chat rather than taken from the body.
   * The bot is not the authority on who a chat belongs to; `users.telegram_chat_id`
   * is, and deriving it keeps that true even if a caller gets it wrong.
   */
  async saveFlow(key: FieldActorKey, body: unknown) {
    const chatId = String(key.chatId);
    const payload = this.validateFlowPayload(body);
    const user = db.getUserByTelegramChatId(chatId);

    try {
      const row = await db.saveBotSession({
        chatId,
        userId: user?.id ?? null,
        step: payload.step,
        storeId: payload.storeId ?? null,
        storeCode: payload.storeCode ?? null,
        storeName: payload.storeName ?? null,
        activeTaskId: payload.activeTaskId ?? null,
        activeTaskTitle: payload.activeTaskTitle ?? null,
        latitude: payload.location?.latitude ?? null,
        longitude: payload.location?.longitude ?? null,
        checklistQuestions: payload.checklistQuestions ?? [],
        checklistAnswers: payload.checklistAnswers ?? [],
        checklistIndex: payload.checklistIndex ?? null,
        pendingPhoto: payload.pendingPhoto ?? null,
      });

      return { success: true, data: row ? this.toFlowPayload(row) : null };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`⛔ [FLOW] Could not save the flow for chat ${chatId}: ${detail}`);
      throw new HttpException(
        {
          error: 'FLOW_NOT_STORED',
          message:
            'Davam edən işiniz yadda saxlanıla bilmədi. Heç nə dəyişmədi — yenidən cəhd edin.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /** Forgets a chat's flow. Called when the audit is filed or the person starts over. */
  async clearFlow(key: FieldActorKey) {
    const chatId = String(key.chatId);
    const cleared = await db.clearBotSession(chatId);
    return { success: true, data: { cleared, chatId } };
  }

  // -------------------------------------------------------------------------
  // Notifications — the outbox the bot drains
  // -------------------------------------------------------------------------

  /**
   * Leases the messages waiting to be sent, oldest first.
   *
   * WHY THE BOT ASKS THE API RATHER THAN READING THE TABLE
   * -----------------------------------------------------
   * The bot has no database connection, by design: it reaches data only through
   * this API, which is what keeps one authorisation model instead of two. The
   * outbox is not an exception to that.
   *
   * WHY A LEASE AND NOT JUST A READ
   * -------------------------------
   * Two bot instances overlap for a few seconds on every deploy. A plain read
   * would hand both of them the same rows and the merchandiser would receive the
   * same message twice. The claim writes `claimed_at`, and a row under an
   * unexpired claim is invisible to the next caller — so the second instance
   * walks past it and picks up the next ones. The claim expires, which is what
   * makes delivery at-least-once: a bot killed between claiming and sending
   * leaves the row available again instead of losing it.
   *
   * `chatId` is optional. The bot passes nothing and drains every chat, because
   * it has no way to know which chats have anything waiting; a single chat can
   * be asked for by name, which is what the tests do.
   */
  async claimPendingNotifications(options: {
    chatId?: string;
    limit?: number;
    claimedBy?: string;
  }) {
    // Identifies the drain loop holding the lease, for the "who is holding this
    // and why has it not been sent" question. Not an authorisation input: only a
    // service credential reaches this route at all.
    const claimedBy = options.claimedBy?.trim() || 'bot';

    const rows = await db.claimNotifications({
      chatId: options.chatId ?? null,
      limit: options.limit ?? 20,
      claimedBy,
    });

    return {
      success: true,
      data: rows.map((row) => this.toNotificationPayload(row)),
      total: rows.length,
      claimedBy,
    };
  }

  /** Records that Telegram accepted the message. */
  async markNotificationDelivered(id: string) {
    const delivered = await db.markNotificationDelivered(id);
    return { success: true, data: { id, delivered } };
  }

  /**
   * Records that Telegram refused the message, terminally.
   *
   * A refusal that reaches here is one a retry cannot fix — the chat blocked the
   * bot, or the chat no longer exists. A transient failure (Telegram
   * unreachable) must NOT call this: leaving the claim to expire is what causes
   * the row to be tried again, which is the whole point of the lease.
   */
  async markNotificationFailed(id: string, failure: string) {
    const failed = await db.markNotificationFailed(id, failure);
    return { success: true, data: { id, failed } };
  }

  /**
   * The shape the bot needs, and nothing else.
   *
   * `taskId` is lifted out of `payload` because that is the one thing the bot
   * turns into a button — `open:<taskId>` — and a client that has to reach into
   * a JSON blob to find it is a client that will one day look for the wrong key.
   * The whole payload is not returned: what the message says is `body`, and
   * anything else is the API's business.
   */
  private toNotificationPayload(row: BotNotificationRow) {
    const taskId = row.payload?.taskId;

    return {
      id: row.id,
      chatId: row.chatId,
      kind: row.kind,
      title: row.title,
      body: row.body,
      taskId: typeof taskId === 'string' ? taskId : null,
      createdAt:
        row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    };
  }

  /**
   * Refuses anything that would be stored and then be unreadable.
   *
   * Field-by-field, and only the fields that decide whether the flow can
   * continue. The checklist answers, for instance, are *not* validated against
   * the template here: `EvidenceService` already owns that check and does it at
   * submission time, against the authoritative schema. Doing it twice would mean
   * two places to update and a session that can be saved but not submitted.
   */
  private validateFlowPayload(body: unknown): FieldFlowPayload {
    const payload = (body ?? {}) as Partial<FieldFlowPayload>;

    if (!isBotStep(payload.step)) {
      throw new HttpException(
        {
          error: 'INVALID_FLOW_STEP',
          message: `Axının addımı yanlışdır: ${String(payload.step)}. Qəbul edilən addımlar: ${BOT_STEPS.join(', ')}`,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (payload.checklistQuestions !== undefined && !Array.isArray(payload.checklistQuestions)) {
      throw new HttpException(
        { error: 'INVALID_CHECKLIST_QUESTIONS', message: 'Çeklist sualları siyahı olmalıdır.' },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (payload.checklistAnswers !== undefined && !Array.isArray(payload.checklistAnswers)) {
      throw new HttpException(
        { error: 'INVALID_CHECKLIST_ANSWERS', message: 'Çeklist cavabları siyahı olmalıdır.' },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (payload.checklistIndex !== undefined && payload.checklistIndex !== null) {
      if (!Number.isInteger(payload.checklistIndex) || payload.checklistIndex < 0) {
        throw new HttpException(
          {
            error: 'INVALID_CHECKLIST_INDEX',
            message: 'Çeklist göstəricisi mənfi olmayan tam ədəd olmalıdır.',
          },
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    // A half-written location is worse than none: the geofence would run against
    // a latitude with no longitude, or against `NaN`, and the audit would be
    // filed as verified when nothing was verified.
    if (payload.location !== undefined && payload.location !== null) {
      const { latitude, longitude } = payload.location;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new HttpException(
          {
            error: 'INVALID_FLOW_LOCATION',
            message: 'Lokasiya həm en, həm də uzunluq dərəcəsi tələb edir.',
          },
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    if (payload.pendingPhoto !== undefined && payload.pendingPhoto !== null) {
      if (!payload.pendingPhoto.fileId) {
        throw new HttpException(
          {
            error: 'INVALID_PENDING_PHOTO',
            message: 'Gözləyən şəkil üçün fayl identifikatoru tələb olunur.',
          },
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    return payload as FieldFlowPayload;
  }

  /** Database row → the shape the bot reads back. */
  private toFlowPayload(row: BotSessionRow): FieldFlowPayload {
    return {
      step: row.step as BotStep,
      userId: row.userId,
      storeId: row.storeId,
      storeCode: row.storeCode,
      storeName: row.storeName,
      activeTaskId: row.activeTaskId,
      activeTaskTitle: row.activeTaskTitle,
      location:
        row.latitude !== null && row.longitude !== null
          ? { latitude: row.latitude, longitude: row.longitude }
          : null,
      checklistQuestions: (row.checklistQuestions ?? []) as ChecklistQuestion[],
      checklistAnswers: (row.checklistAnswers ?? []) as ChecklistAnswer[],
      checklistIndex: row.checklistIndex,
      pendingPhoto: (row.pendingPhoto ?? null) as FieldFlowPayload['pendingPhoto'],
    };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Marks a task as received and accepted by the field worker.
   *
   * WHY THE CHAT CHANNEL NEEDS THIS, AND WHY IT IS NOT OPTIONAL
   * ----------------------------------------------------------
   * The lifecycle is strict: PUBLISHED -> DELIVERED -> ACKNOWLEDGED ->
   * IN_PROGRESS -> SUBMITTED, and a review is only legal from SUBMITTED.
   * `EvidenceService` performs the last two steps, so the first two have to
   * happen before a photo arrives or the submission lands on a task that can
   * never be approved — the supervisor's Approve button returns a 400 and the
   * audit is stuck.
   *
   * In the notification flow, DELIVERED is written when the message is pushed
   * and ACKNOWLEDGED when the merchandiser taps the callback button. The bot
   * polls rather than receiving webhooks, so neither of those runs. Opening the
   * task in the chat is the same act as tapping that button, so this walks the
   * two steps then.
   *
   * It is idempotent and only ever moves forward: a task already at
   * ACKNOWLEDGED or beyond is returned untouched, and a DRAFT is refused by the
   * state machine.
   */
  async acknowledgeTask(key: FieldActorKey, taskId: string) {
    const actor = this.requireActor(key);

    const task = db.getTask(taskId);
    if (!task) {
      throw new HttpException(`Tapşırıq tapılmadı: ${taskId}`, HttpStatus.NOT_FOUND);
    }

    if (!db.canUserAccessTask(actor.userId, actor.role, taskId)) {
      throw new HttpException('Bu tapşırıq üçün icazə yoxdur', HttpStatus.FORBIDDEN);
    }

    // Ordered, so each step is a legal transition from the one before it.
    const chain = [TaskState.PUBLISHED, TaskState.DELIVERED, TaskState.ACKNOWLEDGED];

    const targetIndex = chain.indexOf(TaskState.ACKNOWLEDGED);
    const currentIndex = chain.indexOf(task.status);

    // Already at or past ACKNOWLEDGED: nothing to do.
    if (currentIndex === -1 || currentIndex >= targetIndex) {
      return {
        success: true,
        data: { taskId, currentState: task.status, advanced: false },
      };
    }

    let state = task.status;
    for (let i = currentIndex + 1; i <= targetIndex; i++) {
      const result = await this.taskStateService.transitionTask(
        taskId,
        chain[i],
        actor,
        i === targetIndex
          ? 'Sahə işçisi tapşırığı Telegram çatında açdı (qəbul edildi)'
          : 'Tapşırıq işçiyə çatdırıldı',
      );
      state = result.currentState;
    }

    this.logger.log(`📥 [FIELD ACK] Task ${taskId} acknowledged by ${actor.userId}`);

    return { success: true, data: { taskId, currentState: state, advanced: true } };
  }

  /**
   * Claims a single store task for the actor standing in the store.
   *
   * WHY THIS EXISTS ALONGSIDE `claimStoreTasks`
   * -------------------------------------------
   * The bind-time claim (`claimStoreTasks`) takes a store's *unassigned* open
   * work and never disturbs a task that already belongs to someone — that guard
   * is deliberate, so a supervisor can hand a specific task to a specific person.
   *
   * But it left a hole. The panel can dispatch a task with an assignee already
   * chosen (or a task created before dispatch stopped defaulting one), and that
   * assignee need not be the person actually standing in the store. For that
   * chat, bind claims nothing, `canUserAccessTask` stays false, and BOTH the
   * acknowledge and the eventual photo submission `403` — permanently. The task
   * card opens and then quietly files nothing. That was the live IPHONE_TEST
   * symptom: repeated 403s on a `task-panel-…` id with no `[FIELD CLAIM]` line.
   *
   * The store code is the authority here. Binding proved store presence (a
   * validated /start produced this `storeId`), and this platform's whole field
   * model is "whoever holds the code is in the store, and the store's open work
   * is theirs". So opening a task is a deliberate act of taking it on, and this
   * makes that act stick even over a stale panel assignment.
   *
   * WHAT IT WILL NOT DO
   * -------------------
   * It will not take a task someone has actually started: IN_PROGRESS (a
   * checklist mid-answer) or SUBMITTED and beyond (evidence already filed) stay
   * with their owner, because taking one would discard real field work — the one
   * failure this platform must never cause. Only the not-yet-started open states
   * (PUBLISHED / DELIVERED / ACKNOWLEDGED) are takeable, and the task must belong
   * to the very store the caller named. Every takeover is audited with the
   * assignee it replaced.
   */
  claimStoreTask(key: FieldActorKey, taskId: string, storeId: string) {
    const actor = this.requireActor(key);

    const task = db.getTask(taskId);
    if (!task) {
      throw new HttpException(`Tapşırıq tapılmadı: ${taskId}`, HttpStatus.NOT_FOUND);
    }

    // The claim is only ever for the store the caller named, and the task must
    // belong to it — the same trust the bind path already places in a storeId a
    // validated /start produced.
    if (task.storeId !== storeId) {
      throw new HttpException(
        { error: 'TASK_NOT_AT_STORE', message: 'Bu tapşırıq sizin mağazanıza aid deyil.' },
        HttpStatus.FORBIDDEN,
      );
    }

    // Already the caller's — nothing to do, and say so rather than re-writing it.
    if (task.assignedUserId === actor.userId) {
      return {
        success: true,
        data: { taskId, assignedUserId: actor.userId, claimed: false, reason: 'already-owner' },
      };
    }

    // Someone else has started this one: leave it theirs and let the normal
    // access check surface the block. Work in progress is not up for grabs.
    const takeable = new Set(['PUBLISHED', 'DELIVERED', 'ACKNOWLEDGED']);
    if (task.assignedUserId && !takeable.has(task.status)) {
      return {
        success: true,
        data: {
          taskId,
          assignedUserId: task.assignedUserId,
          claimed: false,
          reason: 'in-progress-elsewhere',
        },
      };
    }

    const previousAssignee = task.assignedUserId ?? null;
    db.assignStoreTask(taskId, actor.userId);

    db.logAuditEvent({
      entityType: 'store_task',
      entityId: taskId,
      action: 'TASK_SELF_ASSIGNED',
      actorId: actor.userId,
      payload: {
        storeId,
        via: 'field-open',
        previousAssignee,
        reason: previousAssignee
          ? 'Mağaza kodu ilə: işçi bu mağazadakı tapşırığı öz üzərinə götürdü (əvvəlki təyinat dəyişdirildi).'
          : 'Mağaza kodu ilə: işçi bu mağazanın açıq tapşırığını öz üzərinə götürdü.',
      },
    });

    this.logger.log(
      `📌 [FIELD CLAIM-ONE] ${actor.userId} claimed task ${taskId} at store ${storeId}` +
        (previousAssignee ? ` (was ${previousAssignee})` : ''),
    );

    return {
      success: true,
      data: { taskId, assignedUserId: actor.userId, claimed: true, previousAssignee },
    };
  }

  getStoreByCode(code: string): PanelStore | null {
    const store = db.getStoreByCode(code);
    return store ? this.portal.toPanelStore(store) : null;
  }

  /**
   * The tasks a field worker can act on for a store.
   *
   * DRAFT is excluded because it has not been dispatched, and the two terminal
   * states are excluded because there is nothing left to do. Everything in
   * between is work in progress and stays visible, which is what makes a task
   * disappear from the bot at the right moment rather than never.
   */
  getTasksForStore(storeId: string): PanelTask[] {
    const open = new Set(['PUBLISHED', 'DELIVERED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'SUBMITTED']);
    return db.storeTasks
      .filter((task) => task.storeId === storeId && open.has(task.status))
      .map((task) => this.portal.toPanelTask(task));
  }

  getTaskById(taskId: string): PanelTask | null {
    const task = db.getTask(taskId);
    return task ? this.portal.toPanelTask(task) : null;
  }

  /**
   * The audits filed by whoever the key names.
   *
   * Keyed by actor rather than by store, because a field worker's own history is
   * what both clients show. A caller that wants one store filters the result.
   */
  getSubmissions(key: FieldActorKey, limit = 5): PanelSubmission[] {
    const actor = this.resolveActor(key);
    if (!actor) return [];
    return db.evidences
      .filter((evidence) => evidence.submittedById === actor.userId)
      .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime())
      .slice(0, Math.max(1, Math.min(50, limit)))
      .map((evidence) => this.portal.toPanelSubmission(evidence));
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Records an audit submitted from a chat.
   *
   * THE GEOFENCE CANNOT BE ENFORCED ON THIS CHANNEL, AND THAT IS RECORDED
   * ---------------------------------------------------------------------
   * The anti-fraud check compares the submission's coordinates against the
   * store's. Telegram does not attach coordinates to a photo, so the bot has
   * nothing truthful to send.
   *
   * The dishonest options are worse than the honest one. Sending the store's own
   * coordinates would make every submission pass the geofence and turn a real
   * control into decoration. Skipping the check silently would do the same while
   * also hiding it.
   *
   * So the caller must say `locationUnverified: true`, the store's coordinates
   * are used only so the pipeline can run, and a distinct audit event
   * (`GEOFENCE_NOT_VERIFIED`) is written that a supervisor can see. The
   * submission is therefore usable but visibly weaker evidence than one that
   * came from the mobile client with a real fix.
   *
   * The right fix is to ask the user to share their location in Telegram
   * (`request_location`) before accepting the photo. That is a change to the bot
   * flow rather than to this endpoint, and until it exists the weakness should
   * stay visible rather than be papered over.
   *
   * PHOTOS ARE OFFLOADED WHEN STORAGE IS CONFIGURED, AND INLINE WHEN IT IS NOT
   * -------------------------------------------------------------------------
   * The image arrives as a data URL and used to be stored as one, inside
   * `task_evidences.photo_url`. That works — Telegram compresses a field photo
   * to roughly 50-150 KB — but at a thousand stores submitting daily every
   * database backup would carry every photo, and a `SELECT *` on evidences would
   * drag megabytes through the connection.
   *
   * `StorageService` decides where it goes. With `STORAGE_DRIVER=s3` the bytes
   * are uploaded to the bucket and only the resulting URL is stored; otherwise
   * the data URL is kept exactly as it arrived, so an unconfigured deployment
   * behaves as it always did. The cap below still applies to the inline form,
   * because that is the form whose size lands in a database row.
   *
   * Doing this here — on the value the client already sends — is deliberate.
   * Both channels are offloaded by one rule instead of each client having to
   * remember to, and neither the bot nor the mobile app needed changing.
   *
   * An upload that fails refuses the submission rather than falling back to
   * inline. Quietly falling back would let an operator who configured a bucket
   * believe photos are in it while they are in a table, and the evidence row has
   * not been written yet at this point, so refusing costs one retry and costs
   * the audit trail nothing.
   */
  async submitSubmission(payload: {
    /** Exactly one of these identifies the acting person. See FieldActorKey. */
    chatId?: string | number;
    deviceId?: string;
    storeTaskId: string;
    photoUrl: string;
    photoType?: 'before' | 'after' | 'standard';
    latitude?: number;
    longitude?: number;
    locationUnverified?: boolean;
    /** GPS horizontal accuracy in metres, when the client reports it. */
    accuracy?: number;
    /** True when the device flagged the fix as mock/simulated (Android exposes this). */
    locationMocked?: boolean;
    checklistAnswers?: Array<{ questionId: string; value: boolean | number | string }>;
    metadata?: Record<string, unknown>;
    /** Client-supplied key that makes a resend return the same evidence. */
    idempotencyKey?: string;
    /**
     * The vision engine's read of this photo, when one ran in the bot.
     *
     * TRUSTED, AND WHY THAT IS SAFE HERE
     * ----------------------------------
     * These come from the bot, which holds the service credential — not from a
     * chat. A merchandiser cannot set them: they send a photo, the bot runs the
     * engine, and only the bot reaches this route. So the score that drives
     * auto-approval is produced by our own server, never by the person being
     * judged. (Absent entirely when vision is off — then the record is pending,
     * exactly as before.)
     */
    aiScore?: number;
    aiSummary?: string;
    aiDetections?: unknown[];
    aiConfidence?: number;
    aiNeedsHumanReview?: boolean;
    aiEngine?: string;
    aiModel?: string;
  }) {
    const actor = this.requireActor({ chatId: payload.chatId, deviceId: payload.deviceId });

    if (typeof payload.photoUrl === 'string' && payload.photoUrl.startsWith('data:')) {
      if (payload.photoUrl.length > MAX_PHOTO_BYTES) {
        throw new HttpException(
          {
            error: 'PHOTO_TOO_LARGE',
            message:
              `Şəkil çox böyükdür (${Math.round(payload.photoUrl.length / 1024)} KB). ` +
              `Maksimum ${Math.round(MAX_PHOTO_BYTES / 1024)} KB qəbul edilir.`,
          },
          HttpStatus.PAYLOAD_TOO_LARGE,
        );
      }
    }

    const task = db.getTask(payload.storeTaskId);
    if (!task) {
      throw new HttpException(`Tapşırıq tapılmadı: ${payload.storeTaskId}`, HttpStatus.NOT_FOUND);
    }
    const store = db.getStore(task.storeId);
    if (!store) {
      throw new HttpException(`Mağaza məlumatı tapılmadı: ${task.storeId}`, HttpStatus.NOT_FOUND);
    }

    // Offload the photo before anything is written, so that a storage failure
    // cannot leave a half-recorded audit behind. `photoUrl` from here on is what
    // goes into the record: a bucket URL when storage is configured, and the
    // original data URL when it is not.
    const storedPhoto = await this.storage
      .persistPhoto({
        value: payload.photoUrl,
        scope: `tasks/${payload.storeTaskId}`,
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `⛔ [FIELD] Photo upload failed for task ${payload.storeTaskId}: ${reason}`,
        );
        throw new HttpException(
          {
            error: 'PHOTO_UPLOAD_FAILED',
            message:
              'Şəkli obyekt anbarına yükləmək mümkün olmadı. Zəhmət olmasa bir az ' +
              'sonra yenidən cəhd edin — hesabat hələ qeydə alınmayıb.',
          },
          HttpStatus.BAD_GATEWAY,
        );
      });

    const photoUrl = storedPhoto.url;

    const hasRealFix =
      typeof payload.latitude === 'number' && typeof payload.longitude === 'number';

    if (!hasRealFix && !payload.locationUnverified) {
      throw new HttpException(
        {
          error: 'LOCATION_REQUIRED',
          message:
            'Geolokasiya tələb olunur. Telegram kanalı üçün locationUnverified: true göndərilməlidir.',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!hasRealFix) {
      // Only so the geofence pipeline can run. The audit event below is what
      // records that this location proves nothing.
      db.logAuditEvent({
        entityType: 'task_evidence',
        entityId: payload.storeTaskId,
        action: 'GEOFENCE_NOT_VERIFIED',
        actorId: actor.userId,
        payload: {
          channel: 'telegram',
          reason: 'Telegram foto ilə koordinat göndərmir; geolokasiya yoxlanılmamış hesab olunur.',
          storeLocation: { latitude: store.latitude, longitude: store.longitude },
        },
      });
    }

    // Location-integrity signals. These do NOT reject the audit — a legitimate
    // fix can be low-accuracy indoors, and rejecting would punish honest work —
    // but a mock location or a wildly imprecise one is exactly what a reviewer
    // needs to see, so each is recorded as its own audit event and carried in
    // the channel metadata. `metadata` is checked as a fallback because a client
    // may fold these into it rather than sending them at the top level.
    const meta = (payload.metadata ?? {}) as Record<string, unknown>;
    const locationMocked =
      payload.locationMocked === true || meta.mocked === true || meta.locationMocked === true;
    const accuracyMeters =
      typeof payload.accuracy === 'number'
        ? payload.accuracy
        : typeof meta.accuracy === 'number'
          ? (meta.accuracy as number)
          : null;
    const LOW_CONFIDENCE_ACCURACY_M = 100;
    const lowConfidenceFix =
      hasRealFix && accuracyMeters !== null && accuracyMeters > LOW_CONFIDENCE_ACCURACY_M;

    if (locationMocked) {
      db.logAuditEvent({
        entityType: 'task_evidence',
        entityId: payload.storeTaskId,
        action: 'LOCATION_MOCKED',
        actorId: actor.userId,
        payload: {
          reason: 'Cihaz mövqeyi saxta/simulyasiya kimi işarələdi.',
          accuracyMeters,
        },
      });
    }
    if (lowConfidenceFix) {
      db.logAuditEvent({
        entityType: 'task_evidence',
        entityId: payload.storeTaskId,
        action: 'GEOFENCE_LOW_CONFIDENCE',
        actorId: actor.userId,
        payload: { accuracyMeters, thresholdMeters: LOW_CONFIDENCE_ACCURACY_M },
      });
    }

    // Delegated: geofence, checklist validation and the before/after pipeline
    // all live in EvidenceService and must not be duplicated here.
    //
    // `checklistNotCollected` is DERIVED from what actually arrived. It used to
    // be hardcoded `true`, because the chat flow sent a photo without ever asking
    // the template's questions and every real template carries required ones — so
    // without the flag every submission from a chat was refused with a 400.
    //
    // The bot now walks the merchandiser through the questions (see
    // `handlers/taskFlow.ts`), so the flag is set only when no answers came back
    // at all, and EvidenceService records which required questions went
    // unanswered in a `CHECKLIST_NOT_COLLECTED` audit event.
    //
    // Note what this does NOT do: it does not let a *partial* answer set through.
    // Whatever arrived is validated in full, and a missing required answer is
    // still a 400 — which is exactly why the chat flow offers no skip button.
    const answers = payload.checklistAnswers ?? [];

    const result = await this.evidenceService.submitEvidence(
      {
        storeTaskId: payload.storeTaskId,
        photoUrl,
        photoType: payload.photoType ?? 'standard',
        checklistAnswers: answers as any,
        checklistNotCollected: answers.length === 0,
        latitude: hasRealFix ? (payload.latitude as number) : store.latitude,
        longitude: hasRealFix ? (payload.longitude as number) : store.longitude,
        idempotencyKey: payload.idempotencyKey,
      },
      actor,
    );

    // Recorded on every submission, not only when a bucket is in use: whether
    // the image is in object storage or in the row is a property of the evidence
    // that a reviewer may need to know, and it is not recoverable from the URL
    // alone once a bucket is added later.
    db.logAuditEvent({
      entityType: 'task_evidence',
      entityId: result.evidence.id,
      action: 'EVIDENCE_PHOTO_STORAGE',
      actorId: actor.userId,
      payload: {
        driver: storedPhoto.driver,
        bytes: storedPhoto.bytes,
        key: storedPhoto.key ?? null,
        offloaded: storedPhoto.driver === 's3',
      },
    });

    if (
      (payload.metadata && Object.keys(payload.metadata).length > 0) ||
      locationMocked ||
      accuracyMeters !== null
    ) {
      db.logAuditEvent({
        entityType: 'task_evidence',
        entityId: result.evidence.id,
        action: 'EVIDENCE_CHANNEL_METADATA',
        actorId: actor.userId,
        payload: {
          ...(payload.metadata ?? {}),
          location_verified: hasRealFix,
          location_mocked: locationMocked,
          accuracy_meters: accuracyMeters,
        },
      });
    }

    // --- AI verdict: persist it, and auto-approve ONLY a high-confidence pass -
    //
    // Policy (chosen by the operator): a submission is auto-approved when the
    // engine scored it ≥ 85 AND stood behind that answer (it did not ask for a
    // human, and — when it reports one — its self-confidence is ≥ 0.5).
    // Everything else is left pending for a supervisor. This never auto-REJECTS:
    // a low or unsure score is a reason to look, not a reason to fail honest
    // work on a model's say-so.
    //
    // The approval is done here, server-side, with a system reviewer — NOT by
    // the bot calling the review endpoint. The bot acts as the merchandiser, and
    // a merchandiser may not approve their own audit (see `requireReviewer`).
    let effectiveTaskState = result.taskState;
    if (typeof payload.aiScore === 'number') {
      const score = Math.max(0, Math.min(100, Math.round(payload.aiScore)));
      const confidencePct =
        typeof payload.aiConfidence === 'number'
          ? `${Math.round(payload.aiConfidence * 100)}%`
          : 'naməlum';
      const engineLabel = payload.aiModel
        ? `${payload.aiEngine ?? 'vision'}/${payload.aiModel}`
        : (payload.aiEngine ?? 'vision');
      // A self-describing summary: the reviewer sees the score, how sure the
      // engine was, and which engine, without opening the audit log.
      const composedSummary =
        `🤖 AI (${engineLabel}) — bal ${score}/100, əminlik ${confidencePct}. ` +
        (payload.aiSummary?.trim() || 'Xülasə verilmədi.');

      db.updateEvidence(result.evidence.id, {
        aiScore: score,
        aiSummary: composedSummary,
        aiDetections: (payload.aiDetections as any[]) ?? [],
      });

      const confident =
        payload.aiNeedsHumanReview !== true &&
        (typeof payload.aiConfidence !== 'number' || payload.aiConfidence >= 0.5);
      const qualifies = score >= AI_AUTO_APPROVE_MIN_SCORE && confident;

      db.logAuditEvent({
        entityType: 'task_evidence',
        entityId: result.evidence.id,
        action: qualifies ? 'AI_AUTO_APPROVE_ELIGIBLE' : 'AI_REVIEW_PENDING',
        actorId: AI_REVIEWER_PRINCIPAL.userId,
        payload: {
          score,
          confidence: payload.aiConfidence ?? null,
          needsHumanReview: payload.aiNeedsHumanReview ?? null,
          engine: payload.aiEngine ?? null,
          model: payload.aiModel ?? null,
          minScore: AI_AUTO_APPROVE_MIN_SCORE,
        },
      });

      if (qualifies) {
        try {
          const decision = await this.portal.reviewSubmission(
            result.evidence.id,
            { status: 'approved', feedback: composedSummary },
            AI_REVIEWER_PRINCIPAL,
          );
          effectiveTaskState = decision.data.currentState as typeof effectiveTaskState;
          this.logger.log(
            `🤖 [AI AUTO-APPROVE] Evidence ${result.evidence.id} approved (score ${score}, confidence ${confidencePct}).`,
          );
        } catch (error) {
          // A transition that cannot run (e.g. a lone "before" photo that never
          // reached SUBMITTED) is not a failure of the submission — the audit is
          // recorded and simply waits for a human. Never let this throw out.
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `🤖 [AI AUTO-APPROVE SKIPPED] Evidence ${result.evidence.id}: ${reason}`,
          );
        }
      }
    }

    return {
      success: true,
      data: this.portal.toPanelSubmission(result.evidence),
      distanceMeters: result.distanceMeters,
      taskState: effectiveTaskState,
      locationVerified: hasRealFix,
      // Stated explicitly rather than left for the caller to infer from the URL.
      // A client that has just sent a data URL needs to know whether the image
      // was offloaded or stored inline, and the two are indistinguishable from
      // the response body alone once a bucket is configured.
      photoStorage: {
        driver: storedPhoto.driver,
        bytes: storedPhoto.bytes,
        offloaded: storedPhoto.driver === 's3',
      },
    };
  }

  /**
   * Stores one photo and returns the URL to submit with.
   *
   * An optimisation, not a requirement: `submitSubmission` offloads a data URL
   * on its own, so a client can ignore this endpoint entirely and still have its
   * photos land in the bucket. It exists for a client that would rather not push
   * the bytes through the API twice — once to upload, once inside the
   * submission.
   *
   * With `STORAGE_DRIVER=inline` there is nowhere to put the object, so the
   * request is refused with a clear reason rather than answered with a data URL
   * the caller could have produced itself.
   */
  async uploadPhoto(payload: { base64: string; contentType?: string; scope?: string }) {
    const { driver, detail } = this.storage.description;

    if (driver !== 's3') {
      throw new HttpException(
        {
          error: 'STORAGE_NOT_CONFIGURED',
          message:
            'Obyekt anbarı konfiqurasiya edilməyib. Şəkli birbaşa hesabatla ' +
            '(photoUrl sahəsində) göndərin.',
          detail,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const body = Buffer.from(payload.base64.replace(/^data:[^,]*,/, ''), 'base64');
    if (body.length === 0) {
      throw new HttpException(
        { error: 'EMPTY_PHOTO', message: 'Şəkil məlumatı boşdur.' },
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      // Delegated, so that a direct upload and a photo inside a submission
      // produce the same kind of object key. They did not, at first.
      const uploaded = await this.storage.uploadBase64({
        base64: payload.base64,
        contentType: payload.contentType || 'image/jpeg',
        scope: payload.scope,
      });

      return { success: true, data: uploaded };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error('⛔ [FIELD] Direct photo upload failed: ' + reason);
      throw new HttpException(
        { error: 'PHOTO_UPLOAD_FAILED', message: 'Şəkli yükləmək mümkün olmadı.', detail: reason },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
