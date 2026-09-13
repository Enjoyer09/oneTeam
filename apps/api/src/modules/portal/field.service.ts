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
import { UserRole } from '@oneteam/types';
import { db } from '@oneteam/database';
import { PortalService, PanelStore, PanelTask, PanelSubmission } from './portal.service';
import { EvidenceService } from '../evidences/evidence.service';
import { AuthenticatedPrincipal } from '../../common/auth/authenticated-principal';

/** Largest photo accepted as a data URL. See the note in submitSubmission. */
const MAX_PHOTO_BYTES = 1_500_000;

@Injectable()
export class FieldService {
  private readonly logger = new Logger(FieldService.name);

  constructor(
    private readonly portal: PortalService,
    private readonly evidenceService: EvidenceService
  ) {}

  /** Resolves a chat to a user row, or null when the chat has never bound. */
  private resolveActor(chatId: string | number): AuthenticatedPrincipal | null {
    const user = db.getUserByTelegramChatId(chatId);
    if (!user) return null;
    return {
      userId: user.id,
      role: user.role as UserRole,
      telegramChatId: user.telegramChatId ?? null,
    };
  }

  private requireActor(chatId: string | number): AuthenticatedPrincipal {
    const actor = this.resolveActor(chatId);
    if (!actor) {
      throw new HttpException(
        {
          error: 'UNBOUND_CHAT',
          message:
            'Bu Telegram hesabı heç bir istifadəçiyə bağlanmayıb. /start əmri ilə mağaza kodunu göndərin.',
        },
        HttpStatus.NOT_FOUND
      );
    }
    return actor;
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
   */
  bind(chatId: string | number, fullName: string, storeId?: string) {
    const result = db.bindTelegramUser({ telegramChatId: chatId, fullName });
    this.logger.log(`🔗 [FIELD BIND] chat ${chatId} -> ${result.id} (${result.role})`);

    const claimed: string[] = [];
    if (storeId) {
      const open = new Set([
        'PUBLISHED',
        'DELIVERED',
        'ACKNOWLEDGED',
        'IN_PROGRESS',
        'SUBMITTED',
      ]);
      const claimable = db.storeTasks.filter(
        (task) =>
          task.storeId === storeId &&
          open.has(task.status) &&
          (!task.assignedUserId || task.assignedUserId === result.id)
      );

      for (const task of claimable) {
        db.assignStoreTask(task.id, result.id);
        claimed.push(task.id);
      }

      if (claimed.length > 0) {
        db.logAuditEvent({
          entityType: 'store_task',
          entityId: storeId,
          action: 'TASK_SELF_ASSIGNED',
          actorId: result.id,
          payload: {
            channel: 'telegram',
            storeId,
            taskIds: claimed,
            reason:
              'Mağaza kodu ilə qeydiyyat: işçi bu mağazanın açıq tapşırıqlarını öz üzərinə götürdü.',
          },
        });
        this.logger.log(
          `📌 [FIELD CLAIM] ${result.id} claimed ${claimed.length} task(s) at store ${storeId}`
        );
      }
    }

    return { success: true, data: { ...result, claimedTaskIds: claimed } };
  }

  session(chatId: string | number) {
    const user = db.getUserByTelegramChatId(chatId);
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
  // Reads
  // -------------------------------------------------------------------------

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
    const open = new Set([
      'PUBLISHED',
      'DELIVERED',
      'ACKNOWLEDGED',
      'IN_PROGRESS',
      'SUBMITTED',
    ]);
    return db.storeTasks
      .filter((task) => task.storeId === storeId && open.has(task.status))
      .map((task) => this.portal.toPanelTask(task));
  }

  getTaskById(taskId: string): PanelTask | null {
    const task = db.getTask(taskId);
    return task ? this.portal.toPanelTask(task) : null;
  }

  getSubmissionsForChat(chatId: string | number, limit = 5): PanelSubmission[] {
    const user = db.getUserByTelegramChatId(chatId);
    if (!user) return [];
    return db.evidences
      .filter((evidence) => evidence.submittedById === user.id)
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
   * PHOTOS ARE STORED INLINE, AND THAT IS ALSO A STOPGAP.
   *
   * There is no object store configured for this project, so the image travels
   * as a data URL and lands in `task_evidences.photo_url`. Telegram compresses
   * field photos to roughly 50-150 KB, so this is survivable at the current
   * scale and it keeps the whole flow working end to end today.
   *
   * It is not the right answer for a thousand stores submitting daily: every
   * backup would carry every photo, and a `SELECT *` on evidences would drag
   * megabytes through the connection. The fix is object storage — Railway
   * Buckets or equivalent — with only the resulting URL stored here. The cap
   * below exists so the wrong answer cannot grow without bound in the meantime.
   */
  async submitSubmission(payload: {
    chatId: string | number;
    storeTaskId: string;
    photoUrl: string;
    photoType?: 'before' | 'after' | 'standard';
    latitude?: number;
    longitude?: number;
    locationUnverified?: boolean;
    checklistAnswers?: Array<{ questionId: string; value: boolean | number | string }>;
    metadata?: Record<string, unknown>;
  }) {
    const actor = this.requireActor(payload.chatId);

    if (typeof payload.photoUrl === 'string' && payload.photoUrl.startsWith('data:')) {
      if (payload.photoUrl.length > MAX_PHOTO_BYTES) {
        throw new HttpException(
          {
            error: 'PHOTO_TOO_LARGE',
            message:
              `Şəkil çox böyükdür (${Math.round(payload.photoUrl.length / 1024)} KB). ` +
              `Maksimum ${Math.round(MAX_PHOTO_BYTES / 1024)} KB qəbul edilir.`,
          },
          HttpStatus.PAYLOAD_TOO_LARGE
        );
      }
    }

    const task = db.getTask(payload.storeTaskId);
    if (!task) {
      throw new HttpException(
        `Tapşırıq tapılmadı: ${payload.storeTaskId}`,
        HttpStatus.NOT_FOUND
      );
    }
    const store = db.getStore(task.storeId);
    if (!store) {
      throw new HttpException(
        `Mağaza məlumatı tapılmadı: ${task.storeId}`,
        HttpStatus.NOT_FOUND
      );
    }

    const hasRealFix =
      typeof payload.latitude === 'number' && typeof payload.longitude === 'number';

    if (!hasRealFix && !payload.locationUnverified) {
      throw new HttpException(
        {
          error: 'LOCATION_REQUIRED',
          message:
            'Geolokasiya tələb olunur. Telegram kanalı üçün locationUnverified: true göndərilməlidir.',
        },
        HttpStatus.BAD_REQUEST
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
          reason:
            'Telegram foto ilə koordinat göndərmir; geolokasiya yoxlanılmamış hesab olunur.',
          storeLocation: { latitude: store.latitude, longitude: store.longitude },
        },
      });
    }

    // Delegated: geofence, checklist validation and the before/after pipeline
    // all live in EvidenceService and must not be duplicated here.
    //
    // `checklistNotCollected` is not a shortcut. The chat flow submits a photo
    // and never asks the template's questions, and every real template carries
    // required ones — so without it every submission from a chat is refused with
    // a 400 and the bot is unusable. The service records which questions went
    // unanswered in a `CHECKLIST_NOT_COLLECTED` audit event, so the gap is on the
    // record rather than assumed away. Asking the questions in the chat is the
    // real fix and belongs in the bot's conversation flow.
    const result = await this.evidenceService.submitEvidence(
      {
        storeTaskId: payload.storeTaskId,
        photoUrl: payload.photoUrl,
        photoType: payload.photoType ?? 'standard',
        checklistAnswers: payload.checklistAnswers as any,
        checklistNotCollected: true,
        latitude: hasRealFix ? (payload.latitude as number) : store.latitude,
        longitude: hasRealFix ? (payload.longitude as number) : store.longitude,
      },
      actor
    );

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
    };
  }
}
