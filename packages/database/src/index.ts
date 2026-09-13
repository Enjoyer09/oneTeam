/**
 * oneTeam Retail Execution Platform — Database Layer & Repository
 */

export * from './seed';
import { SEED_DATA } from './seed';
import { TaskState, UserRole } from '@oneteam/types';

export interface InMemoryStoreTask {
  id: string;
  templateId: string;
  storeId: string;
  assignedUserId?: string;
  status: TaskState;
  deadline: Date;
  publishedAt?: Date;
  deliveredAt?: Date;
  acknowledgedAt?: Date;
  submittedAt?: Date;
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface InMemoryEvidence {
  id: string;
  storeTaskId: string;
  submittedById: string;
  photoUrl: string;
  photoType?: 'before' | 'after' | 'standard';
  checklistAnswers?: any[];
  latitude: number;
  longitude: number;
  gpsDistanceMeters: number;
  /**
   * AI vision results.
   *
   * `null` is deliberate and distinct from `undefined`:
   *   - `undefined` / absent -> the field was never set on this record
   *   - `null`               -> the AI pass ran but produced no result yet
   *   - value                -> the AI pass produced a result
   *
   * These were declared as plain optionals (`aiScore?: number`), which made
   * the `null` written by EvidenceService a type error (TS2322). Widening the
   * type is the honest fix: the stored state really does have three cases.
   */
  aiScore?: number | null;
  aiDetections?: any[];
  aiSummary?: string | null;
  reviewerFeedback?: string;
  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface InMemoryAuditLog {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  fromState?: string;
  toState?: string;
  actorId?: string;
  payload?: any;
  createdAt: Date;
}

/**
 * Enterprise In-Memory Database Repository
 * Provides guaranteed 0-latency execution, seed state, and audit logs.
 */
export class EnterpriseDatabase {
  public users = [...SEED_DATA.users];
  public region = { ...SEED_DATA.region };
  public stores = [...SEED_DATA.stores];
  public campaign = { ...SEED_DATA.campaign };
  public templates = [...SEED_DATA.templates];
  public storeTasks: InMemoryStoreTask[] = [
    {
      id: 'task-yasamal-cooler-01',
      templateId: 'tmpl-cooler-check',
      storeId: 'str-bravo-yasamal',
      assignedUserId: 'usr-merch-003',
      status: TaskState.PUBLISHED,
      deadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      publishedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'task-ganjlik-eyelevel-02',
      templateId: 'tmpl-eye-level',
      storeId: 'str-araz-ganjlik',
      assignedUserId: 'usr-merch-003',
      status: TaskState.DRAFT,
      deadline: new Date(Date.now() + 5 * 24 * 3600 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'task-portbaku-cooler-03',
      templateId: 'tmpl-cooler-check',
      storeId: 'str-bazarstore-portbaku',
      assignedUserId: 'usr-merch-003',
      status: TaskState.SUBMITTED,
      deadline: new Date(Date.now() + 4 * 24 * 3600 * 1000),
      publishedAt: new Date(Date.now() - 3600000),
      deliveredAt: new Date(Date.now() - 3000000),
      acknowledgedAt: new Date(Date.now() - 2400000),
      submittedAt: new Date(Date.now() - 600000),
      createdAt: new Date(Date.now() - 3600000),
      updatedAt: new Date(Date.now() - 600000),
    },
  ];
  public evidences: InMemoryEvidence[] = [];
  public auditLogs: InMemoryAuditLog[] = [];

  /**
   * Records immutable audit trail event
   */
  public logAuditEvent(params: {
    entityType: string;
    entityId: string;
    action: string;
    fromState?: string;
    toState?: string;
    actorId?: string;
    payload?: any;
  }): InMemoryAuditLog {
    const entry: InMemoryAuditLog = {
      id: `audit-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      fromState: params.fromState,
      toState: params.toState,
      actorId: params.actorId,
      payload: params.payload,
      createdAt: new Date(),
    };
    this.auditLogs.push(entry);
    return entry;
  }

  public getUser(userId: string) {
    return this.users.find((user) => user.id === userId) || null;
  }

  public getUserByTelegramChatId(telegramChatId: string | number) {
    const chatId = String(telegramChatId);
    return this.users.find((user) => user.telegramChatId === chatId) || null;
  }

  public getStore(storeId: string) {
    return this.stores.find((s) => s.id === storeId) || null;
  }

  public getStoreByCode(code: string) {
    return this.stores.find((s) => s.storeCode.toUpperCase() === code.toUpperCase()) || null;
  }

  public getTemplate(templateId: string) {
    return this.templates.find((t) => t.id === templateId) || null;
  }

  public getStoresFiltered(filter: {
    regionId?: string;
    chainName?: string;
    storeFormat?: string;
  }) {
    return this.stores.filter((store) => {
      if (!store.isActive) return false;
      if (filter.regionId && filter.regionId !== 'all' && store.regionId !== filter.regionId) {
        return false;
      }
      if (
        filter.chainName &&
        filter.chainName !== 'all' &&
        store.chainName.toLowerCase() !== filter.chainName.toLowerCase()
      ) {
        return false;
      }
      if (
        filter.storeFormat &&
        filter.storeFormat !== 'all' &&
        store.storeFormat.toLowerCase() !== filter.storeFormat.toLowerCase()
      ) {
        return false;
      }
      return true;
    });
  }

  public getTask(taskId: string) {
    return this.storeTasks.find((t) => t.id === taskId) || null;
  }

  public canUserAccessTask(userId: string, role: UserRole, taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;
    if (role === UserRole.ADMIN || role === UserRole.SUPERVISOR) return true;
    if (role === UserRole.MERCHANDISER) return task.assignedUserId === userId;
    return false;
  }

  public getTasksForUser(userId: string, role: UserRole): InMemoryStoreTask[] {
    if (role === UserRole.ADMIN || role === UserRole.SUPERVISOR) {
      return [...this.storeTasks];
    }
    if (role === UserRole.MERCHANDISER) {
      return this.storeTasks.filter((task) => task.assignedUserId === userId);
    }
    return [];
  }

  public getEvidencesForUser(userId: string, role: UserRole): InMemoryEvidence[] {
    if (role === UserRole.ADMIN || role === UserRole.SUPERVISOR) {
      return [...this.evidences];
    }
    if (role === UserRole.MERCHANDISER) {
      const taskIds = new Set(
        this.storeTasks
          .filter((task) => task.assignedUserId === userId)
          .map((task) => task.id)
      );
      return this.evidences.filter((evidence) => taskIds.has(evidence.storeTaskId));
    }
    return [];
  }

  public updateTaskState(taskId: string, newState: TaskState): InMemoryStoreTask | null {
    const task = this.getTask(taskId);
    if (!task) return null;

    task.status = newState;
    task.updatedAt = new Date();

    if (newState === TaskState.PUBLISHED) task.publishedAt = new Date();
    if (newState === TaskState.DELIVERED) task.deliveredAt = new Date();
    if (newState === TaskState.ACKNOWLEDGED) task.acknowledgedAt = new Date();
    if (newState === TaskState.SUBMITTED) task.submittedAt = new Date();
    if (newState === TaskState.APPROVED || newState === TaskState.REJECTED) {
      task.reviewedAt = new Date();
    }

    return task;
  }
}

export const db = new EnterpriseDatabase();
