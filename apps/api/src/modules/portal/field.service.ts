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
import { db, type BotSessionRow } from '@oneteam/database';
import { PortalService, PanelStore, PanelTask, PanelSubmission } from './portal.service';
import { EvidenceService } from '../evidences/evidence.service';
import { TaskStateService } from '../tasks/task-state.service';
import { StorageService } from '../storage/storage.service';
import { AuthenticatedPrincipal } from '../../common/auth/authenticated-principal';

/** Largest photo accepted as a data URL. See the note in submitSubmission. */
const MAX_PHOTO_BYTES = 1_500_000;

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
    checklistAnswers?: Array<{ questionId: string; value: boolean | number | string }>;
    metadata?: Record<string, unknown>;
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

    if (payload.metadata && Object.keys(payload.metadata).length > 0) {
      db.logAuditEvent({
        entityType: 'task_evidence',
        entityId: result.evidence.id,
        action: 'EVIDENCE_CHANNEL_METADATA',
        actorId: actor.userId,
        payload: {
          ...payload.metadata,
          location_verified: hasRealFix,
        },
      });
    }

    return {
      success: true,
      data: this.portal.toPanelSubmission(result.evidence),
      distanceMeters: result.distanceMeters,
      taskState: result.taskState,
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
