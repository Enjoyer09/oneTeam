import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import {
  SubmitEvidenceRequestDto,
  TaskState,
  checkStoreGeofence,
  GEOFENCE_MAX_DISTANCE_METERS,
} from '@oneteam/types';
import { db, InMemoryEvidence } from '@oneteam/database';
import { TaskStateService } from '../tasks/task-state.service';
import { AuthenticatedPrincipal } from '../../common/auth/authenticated-principal';

@Injectable()
export class EvidenceService {
  private readonly logger = new Logger(EvidenceService.name);

  constructor(private readonly taskStateService: TaskStateService) {}

  /**
   * Submits shelf audit photo evidence with anti-fraud GPS geofence verification (< 100m).
   */
  async submitEvidence(
    dto: SubmitEvidenceRequestDto,
    principal: AuthenticatedPrincipal,
  ): Promise<{
    success: boolean;
    evidence: InMemoryEvidence;
    distanceMeters: number;
    taskState: TaskState;
  }> {
    const task = db.getTask(dto.storeTaskId);
    if (!task) {
      throw new HttpException(`Tapşırıq tapılmadı: ${dto.storeTaskId}`, HttpStatus.NOT_FOUND);
    }

    if (!db.canUserAccessTask(principal.userId, principal.role, dto.storeTaskId)) {
      throw new HttpException('Bu tapşırıq üçün icazə yoxdur', HttpStatus.FORBIDDEN);
    }

    const store = db.getStore(task.storeId);
    if (!store) {
      throw new HttpException(`Mağaza məlumatı tapılmadı: ${task.storeId}`, HttpStatus.NOT_FOUND);
    }

    // 1. Anti-Fraud Geofencing Calculation (Haversine Distance Check)
    const geofence = checkStoreGeofence(
      { latitude: dto.latitude, longitude: dto.longitude },
      { latitude: store.latitude, longitude: store.longitude },
      GEOFENCE_MAX_DISTANCE_METERS,
    );

    if (!geofence.isWithinGeofence) {
      this.logger.warn(
        `⚠️ [GEOFENCE REJECTION] Audit outside allowed perimeter: ${geofence.distanceMeters}m (Max: ${geofence.maxAllowedMeters}m)`,
      );

      // Log anti-fraud security rejection in audit log
      db.logAuditEvent({
        entityType: 'task_evidence',
        entityId: dto.storeTaskId,
        action: 'GEOFENCE_REJECTION',
        actorId: principal.userId,
        payload: {
          userLocation: { latitude: dto.latitude, longitude: dto.longitude },
          storeLocation: { latitude: store.latitude, longitude: store.longitude },
          distanceMeters: geofence.distanceMeters,
          maxAllowedMeters: geofence.maxAllowedMeters,
        },
      });

      throw new HttpException(
        {
          success: false,
          error: 'GEOFENCE_VIOLATION',
          message: geofence.message,
          distanceMeters: geofence.distanceMeters,
          maxAllowedMeters: geofence.maxAllowedMeters,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const template = db.getTemplate(task.templateId);

    // 2. Dynamic Checklist Schema Validation
    //
    // `checklistNotCollected` is set only by the Telegram channel, which submits
    // a photo without asking the template's questions. Refusing the submission
    // would make the bot unusable on every real task, and pretending the answers
    // arrived would hide a control that is not being applied — so the gap is
    // recorded and reported instead of either. See the DTO for the full note.
    const unansweredRequired: string[] = [];

    if (template?.checklistSchema && template.checklistSchema.length > 0) {
      for (const q of template.checklistSchema) {
        const answer = dto.checklistAnswers?.find((a) => a.questionId === q.id);

        if (q.required) {
          if (
            !answer ||
            answer.value === undefined ||
            answer.value === null ||
            answer.value === ''
          ) {
            if (dto.checklistNotCollected) {
              unansweredRequired.push(q.id);
              continue;
            }

            const errorMsg = `Məcburi çeklist sualı cavablandırılmayıb: '${q.question}' (ID: ${q.id})`;
            this.logger.warn(`❌ [CHECKLIST VALIDATION FAILED] ${errorMsg}`);
            throw new HttpException(
              {
                success: false,
                error: 'MISSING_REQUIRED_CHECKLIST_QUESTION',
                questionId: q.id,
                question: q.question,
                message: errorMsg,
              },
              HttpStatus.BAD_REQUEST,
            );
          }
        }

        if (answer && answer.value !== undefined && answer.value !== null && answer.value !== '') {
          if (q.type === 'boolean' && typeof answer.value !== 'boolean') {
            throw new HttpException(
              {
                success: false,
                error: 'INVALID_CHECKLIST_ANSWER_TYPE',
                questionId: q.id,
                message: `'${q.question}' sualı üçün cavab Bəli/Xeyr (boolean) tipində olmalıdır.`,
              },
              HttpStatus.BAD_REQUEST,
            );
          }

          if (q.type === 'number') {
            if (typeof answer.value !== 'number' || isNaN(answer.value)) {
              throw new HttpException(
                {
                  success: false,
                  error: 'INVALID_CHECKLIST_ANSWER_TYPE',
                  questionId: q.id,
                  message: `'${q.question}' sualı üçün cavab rəqəm (number) tipində olmalıdır.`,
                },
                HttpStatus.BAD_REQUEST,
              );
            }
            if (q.minValue !== undefined && answer.value < q.minValue) {
              throw new HttpException(
                {
                  success: false,
                  error: 'CHECKLIST_NUMBER_OUT_OF_RANGE',
                  questionId: q.id,
                  message: `'${q.question}' üçün daxil edilmiş qiymət (${answer.value}) minimum həddən (${q.minValue}) kiçikdir.`,
                },
                HttpStatus.BAD_REQUEST,
              );
            }
            if (q.maxValue !== undefined && answer.value > q.maxValue) {
              throw new HttpException(
                {
                  success: false,
                  error: 'CHECKLIST_NUMBER_OUT_OF_RANGE',
                  questionId: q.id,
                  message: `'${q.question}' üçün daxil edilmiş qiymət (${answer.value}) maksimum həddən (${q.maxValue}) böyükdür.`,
                },
                HttpStatus.BAD_REQUEST,
              );
            }
          }

          if (q.type === 'single_choice') {
            if (
              typeof answer.value !== 'string' ||
              (q.options && !q.options.includes(answer.value))
            ) {
              throw new HttpException(
                {
                  success: false,
                  error: 'INVALID_CHECKLIST_OPTION',
                  questionId: q.id,
                  message: `'${q.question}' üçün seçilmiş variant ('${answer.value}') qəbul olunan seçimlər arasında yoxdur: [${q.options?.join(', ')}].`,
                },
                HttpStatus.BAD_REQUEST,
              );
            }
          }
        }
      }
    }

    // Record what the channel could not collect, before the evidence exists, so
    // the gap is visible even if a later step fails.
    if (unansweredRequired.length > 0) {
      this.logger.warn(
        `⚠️ [CHECKLIST NOT COLLECTED] Task ${dto.storeTaskId}: ` +
          `${unansweredRequired.length} required question(s) unanswered`,
      );
      db.logAuditEvent({
        entityType: 'task_evidence',
        entityId: dto.storeTaskId,
        action: 'CHECKLIST_NOT_COLLECTED',
        actorId: principal.userId,
        payload: {
          unansweredQuestionIds: unansweredRequired,
          reason: 'Kanaldan çeklist cavabları toplanmır; cavablar yoxlanılmamış hesab olunur.',
        },
      });
    }

    // 3. Before & After Photo Pipeline Flow
    const photoType = dto.photoType || 'standard';
    const requiresBeforeAfter = template?.requiresBeforeAfterPhoto ?? false;

    if (requiresBeforeAfter && photoType === 'after') {
      const hasBeforePhoto = db.evidences.some(
        (e) => e.storeTaskId === dto.storeTaskId && e.photoType === 'before',
      );
      if (!hasBeforePhoto) {
        throw new HttpException(
          {
            success: false,
            error: 'MISSING_BEFORE_PHOTO',
            message:
              "Bu təlimat həm 'Before', həm də 'After' fotosu tələb edir. Yekun təqdimatdan əvvəl ilkin 'Before' foto yüklənməlidir.",
          },
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    // Advance Task State
    if (task.status === TaskState.ACKNOWLEDGED) {
      await this.taskStateService.transitionTask(
        task.id,
        TaskState.IN_PROGRESS,
        principal,
        photoType === 'before'
          ? 'Sahə işçisi ilkin (Before) rəf fotosunu çəkdi'
          : 'Sahə işçisi foto çəkilişinə başladı',
      );
    }

    // If template requires before/after, only 'after' (or standard) advances to SUBMITTED
    if (
      task.status === TaskState.IN_PROGRESS &&
      (!requiresBeforeAfter || photoType === 'after' || photoType === 'standard')
    ) {
      await this.taskStateService.transitionTask(
        task.id,
        TaskState.SUBMITTED,
        principal,
        requiresBeforeAfter
          ? `Before & After audit tamamlandı və təqdim edildi (Məsafə: ${geofence.distanceMeters}m)`
          : `Rəf fotosu yükləndi (Məsafə: ${geofence.distanceMeters}m)`,
      );
    }

    // 4. Store Evidence Record
    const now = Date.now();
    const evidenceRecord: InMemoryEvidence = {
      id: `evd-${now}-${Math.random().toString(36).substr(2, 6)}`,
      storeTaskId: dto.storeTaskId,
      submittedById: principal.userId,
      photoUrl: dto.photoUrl,
      photoType,
      checklistAnswers: dto.checklistAnswers || [],
      latitude: dto.latitude,
      longitude: dto.longitude,
      gpsDistanceMeters: geofence.distanceMeters,
      aiScore: null,
      aiDetections: [],
      aiSummary: null,
      submittedAt: new Date(now),
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };

    db.createEvidence(evidenceRecord);

    // 5. Record Evidence Submission in Audit Log
    db.logAuditEvent({
      entityType: 'task_evidence',
      entityId: evidenceRecord.id,
      action: 'EVIDENCE_SUBMITTED',
      toState: task.status,
      actorId: principal.userId,
      payload: {
        photoUrl: dto.photoUrl,
        photoType,
        checklistCount: dto.checklistAnswers?.length || 0,
        distanceMeters: geofence.distanceMeters,
      },
    });

    this.logger.log(
      `✅ [EVIDENCE ACCEPTED] Evidence ${evidenceRecord.id} (${photoType}) verified and stored (${geofence.distanceMeters}m from store)`,
    );

    return {
      success: true,
      evidence: evidenceRecord,
      distanceMeters: geofence.distanceMeters,
      taskState: task.status,
    };
  }
}
