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

import {
  Injectable,
  HttpException,
  HttpStatus,
  Logger,
  ForbiddenException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { TaskState, UserRole } from '@oneteam/types';
import { db, InMemoryEvidence, InMemoryStoreTask } from '@oneteam/database';
import {
  AuthenticatedPrincipal,
  isPrivilegedPrincipal,
} from '../../common/auth/authenticated-principal';
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

  /**
   * The ids the edit and delete forms need.
   *
   * A panel task is a projection of one `store_tasks` row, so editing it means
   * editing that row (deadline, assignee) or the template behind it (title,
   * checklist). The panel cannot guess either id from what it renders, and
   * inventing a lookup by title would be exactly the kind of guess this
   * codebase has been burned by.
   */
  template_id: string;
  store_id: string;
  assigned_user_id: string | null;

  /**
   * What kind of work this is, DERIVED from the columns that exist.
   *
   * There is no `task_type` column, and adding one would create a label with no
   * behaviour behind it. The three kinds the plan asks for are already
   * expressible: a checklist means `checklist_schema` is populated, a photo
   * comparison means `requires_before_after_photo` is set, and anything else is
   * a plain audit. This is computed, never stored, so it cannot drift from the
   * fields it describes.
   */
  kind: 'CHECKLIST' | 'PHOTO' | 'AUDIT';

  /** How many store tasks share this task's template. See `updateTask`. */
  sibling_task_count: number;

  /** Submitted evidence against this store task. A task with any cannot be deleted. */
  evidence_count: number;
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
      template_id: task.templateId,
      store_id: task.storeId,
      assigned_user_id: task.assignedUserId ?? null,
      kind: PortalService.deriveTaskKind(template),
      sibling_task_count: db.storeTasks.filter((t) => t.templateId === task.templateId).length,
      evidence_count: db.evidences.filter((e) => e.storeTaskId === task.id).length,
    };
  }

  /**
   * Names the kind of work a task is, from the fields it actually has.
   *
   * See the `kind` field on `PanelTask` for why this is derived rather than
   * stored. A template with both a checklist and a before/after requirement is
   * reported as CHECKLIST, because that is the stricter of the two: the field
   * client will refuse a submission with unanswered checklist items, whereas the
   * second photo is a separate evidence row.
   */
  private static deriveTaskKind(template: any): 'CHECKLIST' | 'PHOTO' | 'AUDIT' {
    if (Array.isArray(template?.checklistSchema) && template.checklistSchema.length > 0) {
      return 'CHECKLIST';
    }
    if (template?.requiresBeforeAfterPhoto) return 'PHOTO';
    return 'AUDIT';
  }

  toPanelSubmission(evidence: InMemoryEvidence): PanelSubmission {
    const task = db.getTask(evidence.storeTaskId);
    const store = task ? db.getStore(task.storeId) : null;
    const submitter = db.getUser(evidence.submittedById);

    // A before/after task produces two evidence rows. The panel shows one card
    // with both photos, so the "before" row is looked up and attached to
    // whichever row is being rendered.
    const beforePhoto = db.evidences.find(
      (e) => e.storeTaskId === evidence.storeTaskId && e.photoType === 'before',
    );

    return {
      id: evidence.id,
      task_id: evidence.storeTaskId,
      store_id: task?.storeId ?? '',
      submitted_by: evidence.submittedById ?? null,
      photo_url: evidence.photoUrl,
      photo_type: evidence.photoType ?? 'standard',
      before_photo_url:
        evidence.photoType === 'before' ? evidence.photoUrl : (beforePhoto?.photoUrl ?? null),
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

  // -------------------------------------------------------------------------
  // Store writes
  //
  // Stores are created, edited and deleted in the panel and nowhere else. The
  // bot and the mobile client read them and never write them: a store code, an
  // address and a pair of coordinates decide whether a field worker's photo is
  // accepted, so getting them wrong is not a cosmetic problem. See the plan's
  // architecture table for why this is a supervisor's job rather than a
  // field worker's.
  // -------------------------------------------------------------------------

  /**
   * The shape both the create and the edit form send.
   *
   * Everything is optional on the wire because the edit form sends only what
   * changed; the create path is what requires the fields, and it says so with
   * its own messages rather than by making the type narrower.
   */
  private static readonly STORE_FORMATS = ['hypermarket', 'supermarket', 'express', 'convenience'];

  /**
   * The box the pilot operates in.
   *
   * This is a typo guard, not a policy: Azerbaijan is roughly 38–42°N and
   * 44–52°E, and a missing decimal point turns 40.385 into 4.0385 — a valid
   * coordinate that is four thousand kilometres away and would make the
   * geofence refuse every photo from that store, with nothing in the panel to
   * explain why. Widen this if the pilot ever leaves the country.
   */
  private static readonly PLAUSIBLE_BOUNDS = {
    minLatitude: 38,
    maxLatitude: 43,
    minLongitude: 44,
    maxLongitude: 52,
  };

  /**
   * Refuses a caller who may not change master data.
   *
   * `ADMIN` and `SUPERVISOR` may; `MERCHANDISER` and `STORE_STAFF` may not. The
   * panel's login key already narrows the caller to one person, so this is the
   * second boundary rather than the first — and the one that keeps a
   * merchandiser who is handed a login from redefining their own geofence.
   */
  private requireStoreEditor(principal: AuthenticatedPrincipal): void {
    if (!isPrivilegedPrincipal(principal)) {
      throw new ForbiddenException({
        error: 'STORE_EDIT_FORBIDDEN',
        message: 'Mağaza məlumatlarını yalnız administrator və supervayzer dəyişə bilər.',
      });
    }
  }

  /**
   * Reads the store fields off a request body, refusing anything unusable.
   *
   * Returns only the fields that were actually present, so the same method
   * serves both "create with everything" and "edit one field".
   */
  private readStoreFields(
    body: Record<string, any>,
    options: { requireAll: boolean },
  ): {
    storeCode?: string;
    name?: string;
    chainName?: string;
    storeFormat?: any;
    address?: string;
    city?: string;
    latitude?: number;
    longitude?: number;
    isActive?: boolean;
  } {
    const fields: Record<string, any> = {};

    /**
     * Reads a text field.
     *
     * `required` is per-field rather than one flag for the whole body. It was
     * one flag at first, and the first live create without a `city` came back
     * "Şəhər tələb olunur" — a field with a perfectly good default had been
     * made mandatory by a flag that was only ever meant to cover the code, the
     * name, the address and the coordinates. The suite did not catch it because
     * its helper always sends every field; the live check did.
     */
    const text = (key: string, label: string, required: boolean): string | undefined => {
      const raw = body[key];
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        if (required) {
          throw new HttpException(`${label} tələb olunur`, HttpStatus.BAD_REQUEST);
        }
        return undefined;
      }
      return String(raw).trim();
    };

    const code = text('store_code', 'Mağaza kodu', options.requireAll);
    if (code !== undefined) {
      // Uppercased rather than accepted as typed: the bot and the mobile client
      // match a code case-insensitively today, and storing two rows that differ
      // only in case would make that matching ambiguous.
      const normalized = code.toUpperCase();
      if (/\s/.test(normalized)) {
        throw new HttpException(
          'Mağaza kodu boşluq ehtiva edə bilməz (məsələn: BRAVO_YASAMAL_01)',
          HttpStatus.BAD_REQUEST,
        );
      }
      fields.storeCode = normalized;
    }

    // Only the three that the database has no default for are required. City,
    // chain and format all have one, so an operator who types a code, a name,
    // an address and a pin gets a usable store.
    const name = text('name', 'Mağazanın adı', options.requireAll);
    if (name !== undefined) fields.name = name;

    const address = text('address', 'Ünvan', options.requireAll);
    if (address !== undefined) fields.address = address;

    const city = text('city', 'Şəhər', false);
    if (city !== undefined) fields.city = city;

    const chainName = text('chain_name', 'Şəbəkə adı', false);
    if (chainName !== undefined) fields.chainName = chainName;

    if (body.store_format !== undefined && body.store_format !== null) {
      const format = String(body.store_format).trim().toLowerCase();
      if (!PortalService.STORE_FORMATS.includes(format)) {
        throw new HttpException(
          `Mağaza növü bunlardan biri olmalıdır: ${PortalService.STORE_FORMATS.join(', ')}`,
          HttpStatus.BAD_REQUEST,
        );
      }
      fields.storeFormat = format;
    } else if (options.requireAll) {
      fields.storeFormat = 'supermarket';
    }

    // Coordinates are validated as a pair and only when at least one was sent,
    // because an edit that renames a store must not be refused for omitting
    // them.
    const hasLat = body.latitude !== undefined && body.latitude !== null;
    const hasLon = body.longitude !== undefined && body.longitude !== null;

    if (hasLat || hasLon || options.requireAll) {
      if (!hasLat || !hasLon) {
        throw new HttpException('Enlem və uzunluq birlikdə verilməlidir', HttpStatus.BAD_REQUEST);
      }

      const latitude = Number(body.latitude);
      const longitude = Number(body.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new HttpException(
          'Enlem və uzunluq rəqəm olmalıdır (məsələn: 40.385012)',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        throw new HttpException(
          'Enlem -90..90, uzunluq -180..180 aralığında olmalıdır',
          HttpStatus.BAD_REQUEST,
        );
      }

      const bounds = PortalService.PLAUSIBLE_BOUNDS;
      const inside =
        latitude >= bounds.minLatitude &&
        latitude <= bounds.maxLatitude &&
        longitude >= bounds.minLongitude &&
        longitude <= bounds.maxLongitude;

      if (!inside) {
        throw new HttpException(
          `Koordinat gözlənilən ərazidən kənardadır (${latitude}, ${longitude}). ` +
            'Onluq nöqtəni yoxlayın — səhv koordinat geofence-i söndürər.',
          HttpStatus.BAD_REQUEST,
        );
      }

      fields.latitude = latitude;
      fields.longitude = longitude;
    }

    if (body.is_active !== undefined && body.is_active !== null) {
      fields.isActive = body.is_active === true || String(body.is_active) === 'true';
    }

    return fields;
  }

  /** Creates a store. See `EnterpriseDatabase.createStore` for the write rule. */
  async createStore(body: Record<string, any>, principal: AuthenticatedPrincipal) {
    this.requireStoreEditor(principal);

    const fields = this.readStoreFields(body, { requireAll: true });

    const result = await db.createStore({
      storeCode: fields.storeCode!,
      name: fields.name!,
      address: fields.address!,
      latitude: fields.latitude!,
      longitude: fields.longitude!,
      chainName: fields.chainName,
      storeFormat: fields.storeFormat,
      city: fields.city,
      isActive: fields.isActive,
    });

    if (result.error === 'DUPLICATE_CODE') {
      throw new ConflictException({
        error: 'STORE_CODE_TAKEN',
        message: `"${fields.storeCode}" kodu artıq başqa mağazada istifadə olunur.`,
      });
    }
    if (result.error || !result.store) {
      throw new HttpException(
        'Mağaza yaradıla bilmədi — bazaya yazıla bilmədi, heç nə dəyişmədi.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    db.logAuditEvent({
      entityType: 'store',
      entityId: result.store.id,
      action: 'STORE_CREATED',
      actorId: principal.userId,
      payload: { storeCode: result.store.storeCode, name: result.store.name },
    });

    return { success: true, data: this.toPanelStore(result.store) };
  }

  /** Applies an edit. Only the fields present in the body are touched. */
  async updateStore(storeId: string, body: Record<string, any>, principal: AuthenticatedPrincipal) {
    this.requireStoreEditor(principal);

    const fields = this.readStoreFields(body, { requireAll: false });

    if (Object.keys(fields).length === 0) {
      throw new HttpException('Dəyişdiriləcək heç bir sahə göndərilmədi', HttpStatus.BAD_REQUEST);
    }

    const result = await db.updateStore(storeId, fields);

    if (result.error === 'NOT_FOUND') {
      throw new NotFoundException({
        error: 'STORE_NOT_FOUND',
        message: 'Bu identifikatorla mağaza tapılmadı.',
      });
    }
    if (result.error === 'DUPLICATE_CODE') {
      throw new ConflictException({
        error: 'STORE_CODE_TAKEN',
        message: `"${fields.storeCode}" kodu artıq başqa mağazada istifadə olunur.`,
      });
    }
    if (result.error || !result.store) {
      throw new HttpException(
        'Dəyişiklik yazıla bilmədi — əvvəlki məlumatlar qüvvədə qaldı.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    db.logAuditEvent({
      entityType: 'store',
      entityId: storeId,
      action: 'STORE_UPDATED',
      actorId: principal.userId,
      payload: { changed: Object.keys(fields) },
    });

    return { success: true, data: this.toPanelStore(result.store) };
  }

  /**
   * Deletes a store, or explains why it cannot be deleted.
   *
   * A store with work against it is refused rather than removed, and the
   * refusal names the count so the operator can decide between reassigning the
   * tasks and deactivating the store instead. `409`, not `500`: this is a
   * conflict with the data, not a fault.
   */
  async deleteStore(storeId: string, principal: AuthenticatedPrincipal) {
    this.requireStoreEditor(principal);

    const result = await db.deleteStore(storeId);

    if (result.reason === 'NOT_FOUND') {
      throw new NotFoundException({
        error: 'STORE_NOT_FOUND',
        message: 'Bu identifikatorla mağaza tapılmadı.',
      });
    }
    if (result.reason === 'HAS_TASKS') {
      throw new ConflictException({
        error: 'STORE_HAS_TASKS',
        message:
          `Bu mağazanın ${result.tasks} tapşırığı var — silinə bilməz. ` +
          'Tapşırıqları başqa mağazaya keçirin, ya da mağazanı "deaktiv" edin.',
        tasks: result.tasks,
      });
    }
    if (result.reason === 'NOT_DELETED') {
      throw new HttpException(
        'Mağaza silinə bilmədi — bazadan silinmədi, mağaza yerində qaldı.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    db.logAuditEvent({
      entityType: 'store',
      entityId: storeId,
      action: 'STORE_DELETED',
      actorId: principal.userId,
    });

    return { success: true, data: { id: storeId } };
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
    principal: AuthenticatedPrincipal,
  ) {
    this.requireReviewer(principal);

    if (decision.status !== 'approved' && decision.status !== 'rejected') {
      throw new HttpException(
        "Qərar yalnız 'approved' və ya 'rejected' ola bilər",
        HttpStatus.BAD_REQUEST,
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
        HttpStatus.NOT_FOUND,
      );
    }

    const targetState = decision.status === 'approved' ? TaskState.APPROVED : TaskState.REJECTED;

    // Throws a 400 with the allowed transitions when the task is not SUBMITTED.
    const transition = await this.taskStateService.transitionTask(
      task.id,
      targetState,
      principal,
      decision.feedback ||
        (decision.status === 'approved'
          ? 'Rəf auditi supervayzer tərəfindən təsdiqləndi'
          : 'Rəf auditi supervayzer tərəfindən imtina edildi'),
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
    /**
     * Checked here as well as inside `reviewSubmission`, and before the scoring
     * work rather than after it. `autoApproveSubmission` calls `reviewSubmission`
     * with the same principal, so the refusal would happen anyway — but only
     * after reading the evidence, the task, the template and building the
     * reasons list. Refusing first keeps an unauthorised call from doing work
     * whose result is thrown away.
     */
    this.requireReviewer(principal);

    const evidence = db.evidences.find((e) => e.id === evidenceId);
    if (!evidence) {
      throw new HttpException(`Audit qeydi tapılmadı: ${evidenceId}`, HttpStatus.NOT_FOUND);
    }

    const task = db.getTask(evidence.storeTaskId);
    if (!task) {
      throw new HttpException(
        `Auditə bağlı tapşırıq tapılmadı: ${evidence.storeTaskId}`,
        HttpStatus.NOT_FOUND,
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
    const summary = `Qayda əsaslı yoxlama — bal ${score}/100. ` + reasons.join('; ') + '.';

    const decision = await this.reviewSubmission(
      evidenceId,
      {
        status: passed ? 'approved' : 'rejected',
        feedback: summary,
      },
      principal,
    );

    db.updateEvidence(evidenceId, {
      aiScore: score,
      aiSummary: summary,
      aiDetections: evidence.aiDetections ?? [],
    });

    this.logger.log(
      `🤖 [AUTO REVIEW] Evidence ${evidenceId}: score ${score} -> ${decision.data.status}`,
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
    principal: AuthenticatedPrincipal,
  ) {
    // The role gate was missing here while `bulkDispatchTasks` had one, which
    // meant a merchandiser holding a panel key could dispatch work through the
    // explicit-store path but not through the segmentation path. Two doors to
    // the same room need the same lock.
    this.requireTaskEditor(principal);

    const title = this.requireText(payload.title, 'Tapşırıq başlığı');

    const deadline = this.readDeadline(payload.deadline);
    const priority = this.readPriority(payload.priority);
    const checklistSchema = this.readChecklistSchema(payload.checklist_schema);

    const templateId = `tmpl-panel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stored = await db.createTemplate({
      id: templateId,
      campaignId: db.campaign?.id ?? null,
      title,
      description: typeof payload.description === 'string' ? payload.description : '',
      referenceImageUrl: payload.reference_image_url ?? '',
      priority,
      planogramRules: [],
      requiresBeforeAfterPhoto: payload.requires_before_after_photo ?? false,
      checklistSchema,
    });

    // Awaited, and a failure is reported as one: dispatching from a template
    // that never landed would create store tasks whose foreign key cannot be
    // satisfied, so every one of them would fail too.
    if (stored.error || !stored.template) {
      throw new HttpException(
        'Tapşırıq yaradıla bilmədi — təlimat bazaya yazılmadı, heç nə göndərilmədi.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    // From here on the template exists, and every way this can fail below — a
    // store id that does not exist, a segmentation that matches nothing, no
    // merchandiser to assign to — must not leave the briefing behind.
    // `discardTemplate` declines when any store task was created, so a partial
    // dispatch keeps its template and a total failure does not.
    try {
      // Explicit store selection wins over segmentation. The panel's "create
      // task" form sends store ids; the bulk-dispatch form sends
      // chain/format/region.
      //
      // No assignee is invented here. The panel's form asks which stores, not
      // which person, and defaulting to the first merchandiser silently gave one
      // person every task — which is what stopped anyone else from submitting
      // for that store through the bot. An unassigned task is claimed by whoever
      // is at the store. See dispatchToExplicitStores.
      if (payload.assigned_stores?.length) {
        const result = await this.dispatchToExplicitStores(
          templateId,
          deadline,
          payload.assigned_stores,
          payload.assignedUserId ?? null,
          principal,
        );

        if (result.created.length === 0) {
          throw new HttpException(
            {
              success: false,
              error: 'DISPATCH_FAILED',
              message: 'Heç bir mağazaya göndərilə bilmədi — tapşırıq heç bir mağazada yaranmadı.',
              failures: result.failures,
            },
            HttpStatus.SERVICE_UNAVAILABLE,
          );
        }

        return {
          success: true,
          data: {
            templateId,
            totalStoresMatched: payload.assigned_stores.length,
            tasksCreated: result.created.length,
            taskIds: result.created.map((t) => t.id),
            failures: result.failures.length > 0 ? result.failures : undefined,
          },
        };
      }

      // Segmentation still needs an assignee: `bulkDispatchTasks` refuses to
      // create a task nobody owns, and there is no store list to claim from.
      const assigneeId =
        payload.assignedUserId ?? db.users.find((user) => user.role === UserRole.MERCHANDISER)?.id;

      if (!assigneeId) {
        throw new HttpException(
          'Təyin edilə biləcək merchandiser tapılmadı',
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.taskStateService.bulkDispatchTasks(
        {
          templateId,
          deadline: deadline.toISOString(),
          assignedUserId: assigneeId,
          regionId: payload.regionId,
          chainName: payload.chainName,
          storeFormat: payload.storeFormat,
        },
        principal,
      );

      return { success: true, data: { templateId, ...result } };
    } catch (error) {
      await db.discardTemplate(templateId);
      throw error;
    }
  }

  /**
   * Refuses a caller who may not author or change work.
   *
   * The same rule as `requireStoreEditor`, and for the same reason: a panel key
   * narrows the caller to one person, and this is what stops a merchandiser who
   * has been handed one from dispatching briefings to their colleagues.
   */
  private requireTaskEditor(principal: AuthenticatedPrincipal): void {
    if (!isPrivilegedPrincipal(principal)) {
      throw new ForbiddenException({
        error: 'TASK_EDIT_FORBIDDEN',
        message: 'Tapşırıqları yalnız administrator və supervayzer yarada və dəyişə bilər.',
      });
    }
  }

  /**
   * Refuses a caller who may not judge a submitted audit.
   *
   * This is the third boundary and it is deliberately a separate method rather
   * than a reuse of `requireTaskEditor`, because the two rules are the same
   * today but are not the same rule. Authoring a briefing and signing off on
   * somebody else's work are different powers, and the panel's role model
   * (1.5) may well separate them. Sharing one guard would make that split a
   * silent behaviour change later.
   *
   * WHY IT EXISTS, AND WHY THE HOLE WAS NOT "ANY MERCHANDISER"
   * ---------------------------------------------------------
   * `reviewSubmission` and `autoApproveSubmission` both took a principal and
   * never read its role. Two other guards looked like they covered it:
   *
   *   - `mayUseRoute` keeps a *device* credential off these routes, so the
   *     caller has to hold a panel key. An administrator can issue one to
   *     anybody, and a merchandiser who also does panel work is a normal thing
   *     to have — so this narrows the caller to a person, not to a role.
   *
   *   - `transitionTask` refuses a caller for a task they cannot reach, and
   *     `canUserAccessTask` lets a MERCHANDISER reach exactly one kind of task:
   *     the one assigned to them.
   *
   * That second point is what made the hole exact rather than general. The
   * enrolment flow calls `claimStoreTasks`, which hands a store's open work to
   * whoever enrolled with its code — so **the author of a submission is the
   * assignee of its task**. The one merchandiser who could reach this route was
   * therefore the author of the submission being judged, and could approve
   * their own shelf photo. Verified by deleting this call and watching the
   * roles suite report a 200 where it expects a 403.
   *
   * So this guard is not redundant with the task-access rule: it is the only
   * one of the three that is about the *role* rather than about reachability.
   */
  private requireReviewer(principal: AuthenticatedPrincipal): void {
    if (!isPrivilegedPrincipal(principal)) {
      throw new ForbiddenException({
        error: 'REVIEW_FORBIDDEN',
        message:
          'Auditi yalnız administrator və supervayzer təsdiqləyə və ya imtina edə bilər. ' +
          'Öz işinizi özünüz təsdiqləyə bilməzsiniz.',
      });
    }
  }

  /** Reads a required text field, refusing blank and non-string values. */
  private requireText(raw: unknown, label: string): string {
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      throw new HttpException(`${label} tələb olunur`, HttpStatus.BAD_REQUEST);
    }
    return String(raw).trim();
  }

  /**
   * Reads a deadline, refusing anything that is not a real date.
   *
   * `new Date('sabah')` produces an Invalid Date, and `store_tasks.deadline` is
   * `NOT NULL` with no default — so without this check the row is written with
   * an unusable timestamp and every later comparison against it is false. The
   * message names the expected shape rather than the parser's complaint.
   */
  private readDeadline(raw: unknown): Date {
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      throw new HttpException('Son tarix (deadline) tələb olunur', HttpStatus.BAD_REQUEST);
    }
    const deadline = new Date(String(raw));
    if (Number.isNaN(deadline.getTime())) {
      throw new HttpException(
        'Son tarix düzgün formatda deyil (məsələn: 2026-09-30T18:00)',
        HttpStatus.BAD_REQUEST,
      );
    }
    return deadline;
  }

  /** Reads a priority, defaulting to MEDIUM and refusing anything outside the enum. */
  private readPriority(raw: unknown): string {
    const allowed = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
    if (raw === undefined || raw === null || String(raw).trim() === '') return 'MEDIUM';
    const priority = String(raw).trim().toUpperCase();
    if (!allowed.includes(priority)) {
      throw new HttpException(
        `Prioritet bunlardan biri olmalıdır: ${allowed.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return priority;
  }

  /**
   * Reads a checklist schema.
   *
   * Each item must be an object carrying a question. A bare string or an empty
   * object would be stored happily by Postgres — the column is `jsonb` — and
   * then reach the field client as a checklist item with no question, which the
   * merchandiser cannot answer and the reviewer cannot read.
   */
  private readChecklistSchema(raw: unknown): unknown[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      throw new HttpException('Çeklist siyahı olmalıdır', HttpStatus.BAD_REQUEST);
    }
    return raw.map((item, index) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new HttpException(
          `Çeklistin ${index + 1}-ci bəndi obyekt olmalıdır ({ id, label })`,
          HttpStatus.BAD_REQUEST,
        );
      }
      const record = item as Record<string, unknown>;
      const label = record.label ?? record.text ?? record.title;
      if (label === undefined || String(label).trim() === '') {
        throw new HttpException(
          `Çeklistin ${index + 1}-ci bəndində sual mətni yoxdur (label)`,
          HttpStatus.BAD_REQUEST,
        );
      }
      return { ...record, id: record.id ?? `q${index + 1}`, label: String(label).trim() };
    });
  }

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
   *
   * REPORTS WHAT FAILED, NOT ONLY WHAT SUCCEEDED
   * -------------------------------------------
   * Each insert is awaited and a store whose row did not land is recorded in
   * `failures` rather than counted as created. The panel's dispatch form used to
   * be told "N mağazaya göndərildi" from the length of the id list it had just
   * built, which is a statement about the request, not about the database.
   */
  private async dispatchToExplicitStores(
    templateId: string,
    deadline: Date,
    storeIds: string[],
    assigneeId: string | null,
    principal: AuthenticatedPrincipal,
  ): Promise<{
    created: InMemoryStoreTask[];
    failures: Array<{ storeId: string; storeName: string; reason: string }>;
  }> {
    const created: InMemoryStoreTask[] = [];
    const failures: Array<{ storeId: string; storeName: string; reason: string }> = [];
    const template: any = db.getTemplate(templateId);

    // De-duplicated: the picker sends whatever was ticked, and the same id twice
    // would dispatch the briefing to the same store twice with nothing in the
    // rows afterwards to tell them apart.
    for (const storeId of [...new Set(storeIds)]) {
      const store = db.getStore(storeId);
      if (!store) {
        this.logger.warn(`⚠️ [PANEL DISPATCH] Skipping unknown store ${storeId}`);
        failures.push({ storeId, storeName: storeId, reason: 'Mağaza tapılmadı' });
        continue;
      }

      const task: InMemoryStoreTask = {
        id: `task-panel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        templateId,
        storeId,
        assignedUserId: assigneeId ?? undefined,
        status: TaskState.PUBLISHED,
        deadline,
        publishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const stored = await db.createStoreTask(task);
      if (stored.error || !stored.task) {
        failures.push({ storeId, storeName: store.name, reason: 'Bazaya yazıla bilmədi' });
        continue;
      }

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

    return { created, failures };
  }

  /**
   * Edits a task.
   *
   * A panel task is one `store_tasks` row, and the fields a supervisor might
   * change live in two places:
   *
   *   per this store   deadline, assigned_user_id     → the `store_tasks` row
   *   per the briefing title, description, priority,
   *                    checklist, before/after        → the `task_templates` row
   *
   * The second group is shared with every other store the briefing was
   * dispatched to. That is not an accident of the schema, it is what "one task,
   * many stores" means — but a supervisor who renames one row and silently
   * renames four others has been misled. So the response states how many rows
   * the content change reached, and the panel says so out loud.
   */
  async updateTask(taskId: string, body: Record<string, any>, principal: AuthenticatedPrincipal) {
    this.requireTaskEditor(principal);

    const task = db.getTask(taskId);
    if (!task) {
      throw new NotFoundException({
        error: 'TASK_NOT_FOUND',
        message: 'Bu identifikatorla tapşırıq tapılmadı.',
      });
    }

    const perTask: { deadline?: Date; assignedUserId?: string | null } = {};
    const perTemplate: Record<string, unknown> = {};

    if (body.deadline !== undefined) {
      perTask.deadline = this.readDeadline(body.deadline);
    }

    if (body.assigned_user_id !== undefined) {
      const raw = body.assigned_user_id;
      if (raw === null || raw === '') {
        // An explicit unassignment: the task goes back to being claimable by
        // whoever is at the store. Different from omitting the key.
        perTask.assignedUserId = null;
      } else {
        const userId = String(raw).trim();
        const user = db.getUser(userId);
        if (!user) {
          throw new HttpException(`İstifadəçi tapılmadı: ${userId}`, HttpStatus.BAD_REQUEST);
        }
        if (user.role !== UserRole.MERCHANDISER) {
          throw new HttpException(
            'Tapşırıq yalnız merchandiser istifadəçiyə təyin edilə bilər',
            HttpStatus.BAD_REQUEST,
          );
        }
        perTask.assignedUserId = userId;
      }
    }

    if (body.title !== undefined) {
      perTemplate.title = this.requireText(body.title, 'Tapşırıq başlığı');
    }
    if (body.description !== undefined) {
      perTemplate.description = String(body.description ?? '');
    }
    if (body.priority !== undefined) {
      perTemplate.priority = this.readPriority(body.priority);
    }
    if (body.reference_image_url !== undefined) {
      perTemplate.referenceImageUrl = String(body.reference_image_url ?? '');
    }
    if (body.requires_before_after_photo !== undefined) {
      perTemplate.requiresBeforeAfterPhoto =
        body.requires_before_after_photo === true ||
        String(body.requires_before_after_photo) === 'true';
    }
    if (body.checklist_schema !== undefined) {
      perTemplate.checklistSchema = this.readChecklistSchema(body.checklist_schema);
    }

    const touchesTask = Object.keys(perTask).length > 0;
    const touchesTemplate = Object.keys(perTemplate).length > 0;

    if (!touchesTask && !touchesTemplate) {
      throw new HttpException('Dəyişdiriləcək heç bir sahə göndərilmədi', HttpStatus.BAD_REQUEST);
    }

    const siblingCount = db.storeTasks.filter((t) => t.templateId === task.templateId).length;

    // The per-store row goes first. If the shared content then fails to write,
    // the message can say exactly which half landed, which a single
    // all-or-nothing error could not.
    let updated = task;
    if (touchesTask) {
      const result = await db.updateTask(taskId, perTask);
      if (result.error === 'NOT_FOUND') {
        throw new NotFoundException({
          error: 'TASK_NOT_FOUND',
          message: 'Bu identifikatorla tapşırıq tapılmadı.',
        });
      }
      if (result.error || !result.task) {
        throw new HttpException(
          'Tapşırıq yenilənə bilmədi — bazaya yazılmadı, heç nə dəyişmədi.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      updated = result.task;
    }

    if (touchesTemplate) {
      const result = await db.updateTemplate(task.templateId, perTemplate as any);
      if (result.error === 'NOT_FOUND') {
        throw new NotFoundException({
          error: 'TASK_TEMPLATE_NOT_FOUND',
          message: 'Tapşırığın təlimatı tapılmadı — məzmun dəyişdirilə bilməz.',
        });
      }
      if (result.error || !result.template) {
        throw new HttpException(
          touchesTask
            ? 'Bu mağazanın son tarixi/təyinatı dəyişdi, lakin ümumi məzmun yazıla bilmədi.'
            : 'Məzmun yazıla bilmədi — bazaya heç nə yazılmadı.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
    }

    db.logAuditEvent({
      entityType: 'store_task',
      entityId: taskId,
      action: 'TASK_UPDATED',
      actorId: principal.userId,
      payload: {
        templateId: task.templateId,
        taskFields: Object.keys(perTask),
        templateFields: Object.keys(perTemplate),
        templateEditReachedTasks: touchesTemplate ? siblingCount : 0,
      },
    });

    return {
      success: true,
      data: this.toPanelTask(updated),
      // Stated in the payload rather than left for the UI to infer: the panel
      // has no way to know how many rows share a template.
      templateEditReachedTasks: touchesTemplate ? siblingCount : 0,
    };
  }

  /**
   * Deletes a task, or explains why it cannot be deleted.
   *
   * A task with submissions is refused. `task_evidences.store_task_id` is
   * `ON DELETE CASCADE`, so deleting it would take the photos, the coordinates
   * and the checklist answers with it — silently, and without the supervisor
   * ever seeing what they were removing. `409`, not `500`: this is a conflict
   * with the data, not a fault.
   */
  async deleteTask(taskId: string, principal: AuthenticatedPrincipal) {
    this.requireTaskEditor(principal);

    const result = await db.deleteTask(taskId);

    if (result.reason === 'NOT_FOUND') {
      throw new NotFoundException({
        error: 'TASK_NOT_FOUND',
        message: 'Bu identifikatorla tapşırıq tapılmadı.',
      });
    }
    if (result.reason === 'HAS_EVIDENCE') {
      throw new ConflictException({
        error: 'TASK_HAS_EVIDENCE',
        message:
          `Bu tapşırığa ${result.evidences} audit göndərişi var — silinə bilməz. ` +
          'Silinsə, həmin foto və çeklist cavabları da silinəcəkdi.',
        evidences: result.evidences,
      });
    }
    if (result.reason === 'NOT_DELETED') {
      throw new HttpException(
        'Tapşırıq silinə bilmədi — bazadan silinmədi, tapşırıq yerində qaldı.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    db.logAuditEvent({
      entityType: 'store_task',
      entityId: taskId,
      action: 'TASK_DELETED',
      actorId: principal.userId,
    });

    return { success: true, data: { id: taskId } };
  }
}
