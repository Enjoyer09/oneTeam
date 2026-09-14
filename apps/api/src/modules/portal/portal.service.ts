/**
 * oneTeam — Portal read model
 * ============================================================================
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The web panel and the Telegram bot were both written against a Supabase
 * schema (`stores` / `tasks` / `task_assignments` / `profiles` / `submissions`)
 * that does not exist in the database this platform actually runs on. With
 * `SUPABASE_URL` unset both fall back to a hardcoded mock host, so the panel has
 * been showing two demo stores and one demo task while the real database held
 * three stores and four tasks.
 *
 * The domain model here is deliberately different from the panel's:
 *
 *   panel                      API
 *   -------------------------  ------------------------------------------
 *   one task, many stores      one store_task per (template, store) pair
 *   task.status = 4 values     store_task.status = an 8-state machine
 *   submission.status          no such column — the TASK carries the verdict
 *   task.title/description     these live on the TEMPLATE, not the task
 *
 * Rather than reshape the domain to fit the panel — which would throw away the
 * state machine and the per-store audit trail — this service translates at the
 * boundary. The panel keeps its shapes, the database keeps its model, and the
 * translation lives in exactly one file instead of being spread through the
 * browser bundle.
 *
 * A store task is therefore emitted as its own panel task, with
 * `assigned_stores: [its own store]`. One briefing dispatched to three stores
 * appears as three rows, each with its own real status and deadline. That is
 * more truthful than collapsing them: the panel's "one task, many stores" shape
 * has nowhere to record that store A was approved and store B rejected.
 */

import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { TaskState, UserRole } from '@oneteam/types';
import { db, InMemoryEvidence, InMemoryStoreTask } from '@oneteam/database';
import { AuthenticatedPrincipal } from '../../common/auth/authenticated-principal';
import { TaskStateService } from '../tasks/task-state.service';

/** Panel-side shapes. Mirrors web/src/types/index.ts. */
export interface PanelStore {
  id: string;
  store_code: string;
  name: string;
  chain_name: string;
  store_format: string;
  region_id: string | null;
  address: string | null;
  city: string;
  latitude: number | null;
  longitude: number | null;
  is_active: boolean;
  created_at: string;
}

export interface PanelTask {
  id: string;
  title: string;
  description: string;
  reference_image_url: string | null;
  priority: string;
  status: string;
  deadline: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  assigned_stores: string[];
  requires_before_after_photo: boolean;
  checklist_schema: unknown[];

  /**
   * The template's planogram rules.
   *
   * Added for the mobile field client, which used to display a hardcoded
   * "≤ 4°C, 3 facings per SKU" for every task because the rules never left the
   * server. A field worker reading a made-up planogram is worse served than one
   * reading nothing.
   */
  planogram_rules: unknown[];
}

export interface PanelSubmission {
  id: string;
  task_id: string;
  store_id: string;
  submitted_by: string | null;
  photo_url: string;
  photo_type: string;
  before_photo_url: string | null;
  checklist_answers: unknown[];
  status: 'pending_review' | 'approved' | 'rejected';
  reviewer_feedback: string | null;
  ai_score: number | null;
  ai_detections: unknown[];
  ai_summary: string | null;
  metadata: Record<string, unknown>;
  submitted_at: string;
  reviewed_at: string | null;
  task?: PanelTask;
  store?: PanelStore;
  submitter_name?: string;
}

export interface PanelMetrics {
  totalStores: number;
  activeTasks: number;
  pendingReviews: number;
  complianceRate: number;
}

const iso = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  // The seeded records carry real Date objects, but a store hydrated from a
  // database that predates the created_at column would not. A missing
  // timestamp is not worth failing a whole dashboard render over.
  return new Date().toISOString();
};

/**
 * Collapses the eight-state machine onto the panel's four.
 *
 * `task.status` is not rendered anywhere in the panel today, so this mapping is
 * about keeping the data coherent rather than about pixels. Everything between
 * publication and review reads as "published"; only the two terminal verdicts
 * differ.
 */
function toPanelTaskStatus(state: TaskState): string {
  switch (state) {
    case TaskState.DRAFT:
      return 'draft';
    case TaskState.APPROVED:
      return 'completed';
    case TaskState.REJECTED:
      return 'archived';
    default:
      return 'published';
  }
}

/**
 * The verdict lives on the task, not on the evidence.
 *
 * `task_evidences` has no status column: a submission is judged by moving its
 * store task to APPROVED or REJECTED. The panel expects a status per
 * submission, so it is derived here. An evidence whose task has not been
 * reviewed yet is pending, which is the honest default.
 */
function toPanelSubmissionStatus(state: TaskState | undefined): PanelSubmission['status'] {
  if (state === TaskState.APPROVED) return 'approved';
  if (state === TaskState.REJECTED) return 'rejected';
  return 'pending_review';
}

@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);

  constructor(private readonly taskStateService: TaskStateService) {}

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  toPanelStore(store: any): PanelStore {
    return {
      id: store.id,
      store_code: store.storeCode,
      name: store.name,
      chain_name: store.chainName ?? '—',
      store_format: store.storeFormat ?? 'supermarket',
      region_id: store.regionId ?? null,
      address: store.address ?? null,
      city: store.city ?? 'Bakı',
      latitude: typeof store.latitude === 'number' ? store.latitude : null,
      longitude: typeof store.longitude === 'number' ? store.longitude : null,
      is_active: store.isActive !== false,
      created_at: iso(store.createdAt),
    };
  }

  toPanelTask(task: InMemoryStoreTask): PanelTask {
    // Title, description, reference image, priority and the checklist all live
    // on the template. A store task stores only (template, store, assignee,
    // state, deadline) — so this lookup is not optional decoration, it is where
    // the panel's entire task display comes from.
    const template: any = db.getTemplate(task.templateId);

    return {
      id: task.id,
      title: template?.title ?? 'Şablon tapılmadı',
      description: template?.description ?? '',
      reference_image_url: template?.referenceImageUrl ?? null,
      priority: String(template?.priority ?? 'MEDIUM').toLowerCase(),
      status: toPanelTaskStatus(task.status),
      deadline: iso(task.deadline),
      created_by: task.assignedUserId ?? null,
      created_at: iso(task.createdAt),
      updated_at: iso(task.updatedAt),
      assigned_stores: [task.storeId],
      requires_before_after_photo: template?.requiresBeforeAfterPhoto ?? false,
      checklist_schema: template?.checklistSchema ?? [],
      planogram_rules: template?.planogramRules ?? [],
    };
  }

  toPanelSubmission(evidence: InMemoryEvidence): PanelSubmission {
    const task = db.getTask(evidence.storeTaskId);
    const store = task ? db.getStore(task.storeId) : null;
    const submitter = db.getUser(evidence.submittedById);

    // A before/after task produces two evidence rows. The panel shows one card
    // with both photos, so the "before" row is looked up and attached to
    // whichever row is being rendered.
    const beforePhoto = db.evidences.find(
      (e) => e.storeTaskId === evidence.storeTaskId && e.photoType === 'before'
    );

    return {
      id: evidence.id,
      task_id: evidence.storeTaskId,
      store_id: task?.storeId ?? '',
      submitted_by: evidence.submittedById ?? null,
      photo_url: evidence.photoUrl,
      photo_type: evidence.photoType ?? 'standard',
      before_photo_url:
        evidence.photoType === 'before' ? evidence.photoUrl : beforePhoto?.photoUrl ?? null,
      checklist_answers: evidence.checklistAnswers ?? [],
      status: toPanelSubmissionStatus(task?.status),
      reviewer_feedback: evidence.reviewerFeedback ?? null,
      ai_score: evidence.aiScore ?? null,
      ai_detections: evidence.aiDetections ?? [],
      ai_summary: evidence.aiSummary ?? null,
      metadata: {
        captured_at: iso(evidence.submittedAt),
        gps: { latitude: evidence.latitude, longitude: evidence.longitude },
        gps_distance_meters: evidence.gpsDistanceMeters,
      },
      submitted_at: iso(evidence.submittedAt),
      reviewed_at: task?.reviewedAt ? iso(task.reviewedAt) : null,
      task: task ? this.toPanelTask(task) : undefined,
      store: store ? this.toPanelStore(store) : undefined,
      submitter_name: submitter?.fullName,
    };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  getStores(): PanelStore[] {
    return db.stores.map((store) => this.toPanelStore(store));
  }

  getTasks(): PanelTask[] {
    return db.storeTasks.map((task) => this.toPanelTask(task));
  }

  getSubmissions(): PanelSubmission[] {
    return [...db.evidences]
      .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime())
      .map((evidence) => this.toPanelSubmission(evidence));
  }

  getMetrics(): PanelMetrics {
    const activeStores = db.stores.filter((store) => store.isActive !== false);

    // "Active" means work that is genuinely in flight: published through to
    // submitted. Counting DRAFT would include briefings nobody has been sent
    // yet, and counting APPROVED/REJECTED would make finished work look open.
    const inFlight: TaskState[] = [
      TaskState.PUBLISHED,
      TaskState.DELIVERED,
      TaskState.ACKNOWLEDGED,
      TaskState.IN_PROGRESS,
      TaskState.SUBMITTED,
    ];
    const activeTasks = db.storeTasks.filter((task) => inFlight.includes(task.status)).length;

    const submissions = this.getSubmissions();
    const pendingReviews = submissions.filter((s) => s.status === 'pending_review').length;
    const approved = submissions.filter((s) => s.status === 'approved').length;

    // Share of all submissions that passed. Dividing by the number reviewed
    // instead would report 100% for a store that submitted once and passed,
    // and would divide by zero before anything has been reviewed at all.
    const complianceRate =
      submissions.length === 0 ? 0 : Math.round((approved / submissions.length) * 100);

    return {
      totalStores: activeStores.length,
      activeTasks,
      pendingReviews,
      complianceRate,
    };
  }

  /** Everything the panel needs on first paint, in one round trip. */
  getBootstrap(principal: AuthenticatedPrincipal) {
    return {
      success: true,
      data: {
        stores: this.getStores(),
        tasks: this.getTasks(),
        submissions: this.getSubmissions(),
        metrics: this.getMetrics(),
        session: {
          userId: principal.userId,
          role: principal.role,
          user: db.getUser(principal.userId),
        },
      },
    };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Records a supervisor's decision on a submitted audit.
   *
   * The verdict is applied by moving the store task through the state machine
   * rather than by writing a status onto the evidence, because that is where the
   * verdict lives and it keeps the audit trail consistent with the mobile flow.
   * A task that is not in SUBMITTED cannot be reviewed, and the state machine
   * says so with a 400 rather than letting the panel force an illegal state.
   */
  async reviewSubmission(
    evidenceId: string,
    decision: { status: 'approved' | 'rejected'; feedback?: string },
    principal: AuthenticatedPrincipal
  ) {
    if (decision.status !== 'approved' && decision.status !== 'rejected') {
      throw new HttpException(
        "Qərar yalnız 'approved' və ya 'rejected' ola bilər",
        HttpStatus.BAD_REQUEST
      );
    }

    const evidence = db.evidences.find((e) => e.id === evidenceId);
    if (!evidence) {
      throw new HttpException(`Audit qeydi tapılmadı: ${evidenceId}`, HttpStatus.NOT_FOUND);
    }

    const task = db.getTask(evidence.storeTaskId);
    if (!task) {
      throw new HttpException(
        `Auditə bağlı tapşırıq tapılmadı: ${evidence.storeTaskId}`,
        HttpStatus.NOT_FOUND
      );
    }

    const targetState =
      decision.status === 'approved' ? TaskState.APPROVED : TaskState.REJECTED;

    // Throws a 400 with the allowed transitions when the task is not SUBMITTED.
    const transition = await this.taskStateService.transitionTask(
      task.id,
      targetState,
      principal,
      decision.feedback ||
        (decision.status === 'approved'
          ? 'Rəf auditi supervayzer tərəfindən təsdiqləndi'
          : 'Rəf auditi supervayzer tərəfindən imtina edildi')
    );

    db.updateEvidence(evidenceId, {
      reviewerFeedback: decision.feedback ?? evidence.reviewerFeedback ?? '',
    });

    return {
      success: true,
      data: {
        submissionId: evidenceId,
        status: decision.status,
        taskId: task.id,
        currentState: transition.currentState,
      },
    };
  }

  /**
   * Rule-based auto-approval.
   *
   * BE HONEST ABOUT WHAT THIS IS: it is not a vision model. The repository does
   * contain a shelf-photo analyser (`src/services/aiVision.ts`), but it lives in
   * the bot process and has never been reachable from the API, and the API
   * stores `ai_score` as null on submission. Rather than fake a score, this
   * scores the signals that genuinely exist in the record:
   *
   *   - how far the submission was captured from the store's coordinates
   *   - whether any checklist answers came back at all
   *   - whether this is a lone "before" photo of a before/after task
   *
   * A submission that clears the threshold is approved; one that does not is
   * rejected with the reason, so a supervisor sees why. If the evidence already
   * carries a real `ai_score`, that score is used instead and the rules are
   * skipped.
   */
  async autoApproveSubmission(evidenceId: string, principal: AuthenticatedPrincipal) {
    const evidence = db.evidences.find((e) => e.id === evidenceId);
    if (!evidence) {
      throw new HttpException(`Audit qeydi tapılmadı: ${evidenceId}`, HttpStatus.NOT_FOUND);
    }

    const task = db.getTask(evidence.storeTaskId);
    if (!task) {
      throw new HttpException(
        `Auditə bağlı tapşırıq tapılmadı: ${evidence.storeTaskId}`,
        HttpStatus.NOT_FOUND
      );
    }

    const template: any = db.getTemplate(task.templateId);
    const reasons: string[] = [];
    let score: number;

    if (typeof evidence.aiScore === 'number') {
      score = evidence.aiScore;
      reasons.push(`Mövcud AI balı istifadə olundu (${score})`);
    } else {
      score = 100;

      const distance = evidence.gpsDistanceMeters ?? 0;
      if (distance > 50) {
        score -= 25;
        reasons.push(`Çəkiliş mağazadan ${Math.round(distance)} m aralıda aparılıb (−25)`);
      } else {
        reasons.push(`Geolokasiya mağaza ərazisindədir (${Math.round(distance)} m)`);
      }

      const answers = evidence.checklistAnswers ?? [];
      if (answers.length === 0) {
        score -= 20;
        reasons.push('Çeklist cavabı yoxdur (−20)');
      } else {
        reasons.push(`Çeklist cavabları tamdır (${answers.length} bənd)`);
      }

      if (template?.requiresBeforeAfterPhoto && evidence.photoType === 'before') {
        score -= 10;
        reasons.push('Yalnız "Before" fotosu mövcuddur (−10)');
      }

      score = Math.max(0, Math.min(100, score));
    }

    const passed = score >= 70;
    const summary =
      `Qayda əsaslı yoxlama — bal ${score}/100. ` + reasons.join('; ') + '.';

    const decision = await this.reviewSubmission(
      evidenceId,
      {
        status: passed ? 'approved' : 'rejected',
        feedback: summary,
      },
      principal
    );

    db.updateEvidence(evidenceId, {
      aiScore: score,
      aiSummary: summary,
      aiDetections: evidence.aiDetections ?? [],
    });

    this.logger.log(
      `🤖 [AUTO REVIEW] Evidence ${evidenceId}: score ${score} -> ${decision.data.status}`
    );

    return {
      success: true,
      data: { ...decision.data, aiScore: score, aiSummary: summary, reasons },
    };
  }

  /**
   * Creates a briefing from the panel's form and dispatches it.
   *
   * The panel authors a task ("what to check"), which in this domain is a
   * template; the stores it applies to then become store tasks through the
   * existing bulk dispatch. Doing it in two steps rather than writing store
   * tasks directly means the panel and the mobile flow share one dispatch path,
   * so notifications and audit entries happen identically for both.
   */
  async createAndDispatch(
    payload: {
      title: string;
      description: string;
      reference_image_url?: string;
      priority?: string;
      deadline: string;
      assigned_stores?: string[];
      chainName?: string;
      storeFormat?: string;
      regionId?: string;
      requires_before_after_photo?: boolean;
      checklist_schema?: unknown[];
      assignedUserId?: string;
    },
    principal: AuthenticatedPrincipal
  ) {
    if (!payload.title || !payload.title.trim()) {
      throw new HttpException('Tapşırıq başlığı tələb olunur', HttpStatus.BAD_REQUEST);
    }
    if (!payload.deadline) {
      throw new HttpException('Son tarix (deadline) tələb olunur', HttpStatus.BAD_REQUEST);
    }

    const templateId = `tmpl-panel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.createTemplate({
      id: templateId,
      campaignId: db.campaign?.id ?? null,
      title: payload.title,
      description: payload.description ?? '',
      referenceImageUrl: payload.reference_image_url ?? '',
      priority: String(payload.priority ?? 'MEDIUM').toUpperCase(),
      planogramRules: [],
      requiresBeforeAfterPhoto: payload.requires_before_after_photo ?? false,
      checklistSchema: payload.checklist_schema ?? [],
    });

    // Explicit store selection wins over segmentation. The panel's "create task"
    // form sends store ids; the bulk-dispatch form sends chain/format/region.
    //
    // No assignee is invented here. The panel's form asks which stores, not
    // which person, and defaulting to the first merchandiser silently gave one
    // person every task — which is what stopped anyone else from submitting for
    // that store through the bot. An unassigned task is claimed by whoever is at
    // the store. See dispatchToExplicitStores.
    if (payload.assigned_stores?.length) {
      const created = await this.dispatchToExplicitStores(
        templateId,
        payload.deadline,
        payload.assigned_stores,
        payload.assignedUserId ?? null,
        principal
      );
      return {
        success: true,
        data: {
          templateId,
          totalStoresMatched: created.length,
          tasksCreated: created.length,
          taskIds: created.map((t) => t.id),
        },
      };
    }

    // Segmentation still needs an assignee: `bulkDispatchTasks` refuses to
    // create a task nobody owns, and there is no store list to claim from.
    const assigneeId =
      payload.assignedUserId ??
      db.users.find((user) => user.role === UserRole.MERCHANDISER)?.id;

    if (!assigneeId) {
      throw new HttpException(
        'Təyin edilə biləcək merchandiser tapılmadı',
        HttpStatus.BAD_REQUEST
      );
    }

    const result = await this.taskStateService.bulkDispatchTasks(
      {
        templateId,
        deadline: payload.deadline,
        assignedUserId: assigneeId,
        regionId: payload.regionId,
        chainName: payload.chainName,
        storeFormat: payload.storeFormat,
      },
      principal
    );

    return { success: true, data: { templateId, ...result } };
  }

  /**
   * Dispatches a template to an explicit list of stores.
   *
   * Kept here rather than added to TaskStateService because segmentation-based
   * dispatch is the service's concern and a fixed id list is a panel concern;
   * mixing them would put a second, subtly different dispatch path in the
   * domain service. The state, audit entry and notification behaviour mirror
   * `bulkDispatchTasks` exactly.
   */
  /**
   * Dispatches a template to an explicit list of stores.
   *
   * `assigneeId` may be null, and that is the default the panel produces.
   *
   * WHY AN UNASSIGNED TASK IS THE RIGHT DEFAULT HERE
   * -----------------------------------------------
   * The panel's form asks "which stores", not "which merchandiser". Filling the
   * blank in with the first merchandiser in the table looked helpful and was
   * not: the work then belonged to whoever happened to sort first, and nobody
   * else could submit for that store. The chat channel proved it — a
   * merchandiser who bound to the store was refused, because the task was
   * already someone else's.
   *
   * Leaving it open means whoever is actually at the store can claim it by
   * sending the store code, which is what the field flow already relies on. A
   * named assignee is still honoured when the caller sends one.
   *
   * Kept here rather than added to TaskStateService because segmentation-based
   * dispatch is the service's concern and a fixed id list is a panel concern;
   * mixing them would put a second, subtly different dispatch path in the
   * domain service. The state, audit entry and notification behaviour mirror
   * `bulkDispatchTasks` exactly.
   */
  private async dispatchToExplicitStores(
    templateId: string,
    deadline: string,
    storeIds: string[],
    assigneeId: string | null,
    principal: AuthenticatedPrincipal
  ): Promise<InMemoryStoreTask[]> {
    const created: InMemoryStoreTask[] = [];
    const template: any = db.getTemplate(templateId);

    for (const storeId of storeIds) {
      const store = db.getStore(storeId);
      if (!store) {
        this.logger.warn(`⚠️ [PANEL DISPATCH] Skipping unknown store ${storeId}`);
        continue;
      }

      const task: InMemoryStoreTask = {
        id: `task-panel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        templateId,
        storeId,
        assignedUserId: assigneeId ?? undefined,
        status: TaskState.PUBLISHED,
        deadline: new Date(deadline),
        publishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      db.createStoreTask(task);
      created.push(task);

      db.logAuditEvent({
        entityType: 'store_task',
        entityId: task.id,
        action: 'TASK_PANEL_DISPATCHED',
        fromState: 'DRAFT',
        toState: TaskState.PUBLISHED,
        actorId: principal.userId,
        payload: {
          templateId,
          templateTitle: template?.title,
          storeId,
          storeName: store.name,
          source: 'web-portal',
          assignedUserId: assigneeId,
        },
      });
    }

    return created;
  }
}
