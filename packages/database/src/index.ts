/**
 * oneTeam Retail Execution Platform — Database Layer & Repository
 *
 * The repository keeps its working set in memory and, when a PostgreSQL
 * connection string is configured, treats the database as authoritative:
 * `init()` hydrates the arrays from real rows at start-up, and every mutation
 * is written through. See postgres.ts for why the driver is `pg` and not
 * Prisma, and for the single-instance caveat that comes with it.
 */

export * from './seed';
export * from './types';
import { SEED_DATA } from './seed';
import { TaskState, UserRole } from '@oneteam/types';
import type {
  InMemoryStoreTask,
  InMemoryEvidence,
  InMemoryAuditLog,
} from './types';
import * as pg from './postgres';
import type { Pool } from 'pg';

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

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private pool: Pool | null = null;

  /**
   * Where reads are actually coming from, reported through /api/health.
   *
   * This is deliberately public and explicit. The original bug was not that
   * the database was misconfigured — it was that nothing anywhere said the
   * database was unused, so the application looked healthy while losing every
   * write on restart.
   */
  public persistence: 'postgres' | 'memory' = 'memory';
  public persistenceDetail = 'DATABASE_URL is not set — running on seed data';

  /**
   * Connects to PostgreSQL and replaces the seeded arrays with real rows.
   *
   * Failure is logged and survived rather than fatal: a database that is
   * briefly unavailable should not take the API down with it, and the API is
   * still useful on seed data. What must not happen is failing silently, so the
   * mode is logged at error level and surfaced by /api/health.
   */
  public async init(): Promise<void> {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      console.warn(
        '⚠️  [oneTeam DB] DATABASE_URL is not set. Running entirely in memory — ' +
          'every task, evidence and audit entry will be lost on restart.'
      );
      return;
    }

    try {
      this.pool = pg.createPool(connectionString);
      await pg.ping(this.pool);

      const state = await pg.loadAll(this.pool);

      if (state.users.length > 0) {
        this.users = state.users as typeof this.users;
        if (state.region) this.region = state.region as typeof this.region;
        this.stores = state.stores as typeof this.stores;
        if (state.campaign) this.campaign = state.campaign as typeof this.campaign;
        this.templates = state.templates as typeof this.templates;
        this.storeTasks = state.storeTasks;
        this.evidences = state.evidences;
        this.auditLogs = state.auditLogs;
      } else {
        console.warn(
          '⚠️  [oneTeam DB] Connected, but the users table is empty. Keeping the ' +
            'built-in seed data in memory. Run db/api-seed.sql against this database.'
        );
      }

      this.persistence = 'postgres';
      this.persistenceDetail =
        `postgres — ${this.users.length} users, ${this.stores.length} stores, ` +
        `${this.storeTasks.length} tasks, ${this.evidences.length} evidences, ` +
        `${this.auditLogs.length} audit entries`;
      console.log('✅ [oneTeam DB] ' + this.persistenceDetail);
    } catch (error) {
      this.pool = null;
      this.persistence = 'memory';
      this.persistenceDetail =
        'postgres unavailable: ' + (error instanceof Error ? error.message : String(error));
      console.error(
        '⛔ [oneTeam DB] Could not use PostgreSQL. Falling back to in-memory seed ' +
          'data; writes will NOT survive a restart. Reason: ' + this.persistenceDetail
      );
    }
  }

  /**
   * Fire-and-forget write-through.
   *
   * The callers are synchronous and stay that way — see the note in
   * postgres.ts. A failed write is logged loudly rather than thrown: an audit
   * row that cannot be written should not fail the business operation that
   * produced it, but it must be visible in the logs.
   */
  private persist(op: Promise<unknown>, label: string): void {
    if (!this.pool) return;
    op.catch((error) => {
      console.error(
        `⛔ [oneTeam DB] Failed to persist ${label}: ` +
          (error instanceof Error ? error.message : String(error))
      );
    });
  }

  /** Closes the pool. Used by tests and by graceful shutdown. */
  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

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
    if (this.pool) this.persist(pg.insertAuditLog(this.pool, entry), `audit ${entry.id}`);
    return entry;
  }

  /**
   * Adds a store task and persists it.
   *
   * Replaces a direct `db.storeTasks.push(...)` in the task service. The push
   * is still what makes the task visible to the running process; the insert is
   * what makes it survive.
   */
  public createStoreTask(task: InMemoryStoreTask): InMemoryStoreTask {
    this.storeTasks.push(task);
    if (this.pool) this.persist(pg.insertStoreTask(this.pool, task), `task ${task.id}`);
    return task;
  }

  /**
   * Adds an evidence record and persists it.
   *
   * Replaces a direct `db.evidences.push(...)` in the evidence service.
   */
  public createEvidence(evidence: InMemoryEvidence): InMemoryEvidence {
    this.evidences.push(evidence);
    if (this.pool) this.persist(pg.insertEvidence(this.pool, evidence), `evidence ${evidence.id}`);
    return evidence;
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

    if (this.pool) this.persist(pg.updateStoreTaskRow(this.pool, task), `task ${task.id} state`);

    return task;
  }
}

export const db = new EnterpriseDatabase();
