import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import {
  TaskState,
  UserRole,
  ALLOWED_STATE_TRANSITIONS,
  isValidTransition,
  StateTransitionResponseDto,
  StoreTask,
  BulkDispatchDto,
  BulkDispatchResultDto,
} from '@oneteam/types';
import { db, InMemoryStoreTask } from '@oneteam/database';
import {
  AuthenticatedPrincipal,
  isPrivilegedPrincipal,
} from '../../common/auth/authenticated-principal';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';

@Injectable()
export class TaskStateService {
  private readonly logger = new Logger(TaskStateService.name);

  constructor(private readonly notificationDispatcher: NotificationDispatcherService) {}

  /**
   * Bulk dispatches store tasks to segmented stores matching criteria (region, chain, format).
   * Automatically publishes tasks, logs audit events, and triggers multi-channel notifications.
   */
  async bulkDispatchTasks(
    dto: BulkDispatchDto,
    principal: AuthenticatedPrincipal,
  ): Promise<BulkDispatchResultDto> {
    if (!isPrivilegedPrincipal(principal)) {
      throw new HttpException('Bu əməliyyat üçün icazə yoxdur', HttpStatus.FORBIDDEN);
    }

    const assignedUserId = dto.assignedUserId;
    if (!assignedUserId || !db.getUser(assignedUserId)) {
      throw new HttpException(
        'Mövcud və etibarlı icraçı istifadəçi tələb olunur',
        HttpStatus.BAD_REQUEST,
      );
    }

    const assignee = db.getUser(assignedUserId);
    if (!assignee || assignee.role !== UserRole.MERCHANDISER) {
      throw new HttpException(
        'Tapşırıq yalnız mövcud merchandiser istifadəçiyə təyin edilə bilər',
        HttpStatus.BAD_REQUEST,
      );
    }

    const template = db.getTemplate(dto.templateId);
    if (!template) {
      throw new HttpException(
        `Təlimat şablonu tapılmadı (ID: ${dto.templateId})`,
        HttpStatus.NOT_FOUND,
      );
    }

    const matchedStores = db.getStoresFiltered({
      regionId: dto.regionId,
      chainName: dto.chainName,
      storeFormat: dto.storeFormat,
    });

    if (matchedStores.length === 0) {
      throw new HttpException(
        'Göstərilən seqmentasiya meyarlarına uyğun heç bir aktiv mağaza tapılmadı.',
        HttpStatus.BAD_REQUEST,
      );
    }

    this.logger.log(
      `🚀 [BULK DISPATCH] Dispatching template '${template.title}' to ${matchedStores.length} stores (Chain: ${dto.chainName || 'All'}, Format: ${dto.storeFormat || 'All'})`,
    );

    const createdTasks: InMemoryStoreTask[] = [];
    const failures: Array<{ storeId: string; storeName: string; reason: string }> = [];
    let telegramCount = 0;
    let pushCount = 0;

    for (const store of matchedStores) {
      const taskId = `task-bulk-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      const newTask: InMemoryStoreTask = {
        id: taskId,
        templateId: dto.templateId,
        storeId: store.id,
        assignedUserId,
        status: TaskState.PUBLISHED,
        deadline: new Date(dto.deadline),
        publishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Awaited: the insert either lands or this store is reported as failed.
      // A failed task is not pushed to memory either, so the process's list
      // matches the database and the loop's counts mean something.
      const stored = await db.createStoreTask(newTask);
      if (stored.error || !stored.task) {
        failures.push({
          storeId: store.id,
          storeName: store.name,
          reason: 'Bazaya yazıla bilmədi',
        });
        continue;
      }

      createdTasks.push(newTask);

      // Audit Log
      db.logAuditEvent({
        entityType: 'store_task',
        entityId: taskId,
        action: 'TASK_BULK_DISPATCHED',
        fromState: 'DRAFT',
        toState: TaskState.PUBLISHED,
        actorId: principal.userId,
        payload: {
          templateId: dto.templateId,
          templateTitle: template.title,
          storeId: store.id,
          storeName: store.name,
          chainName: store.chainName,
          storeFormat: store.storeFormat,
        },
      });

      // Dispatch Notifications
      const dispatchRes = await this.notificationDispatcher.dispatchTaskPublished(
        newTask as unknown as StoreTask,
      );
      if (dispatchRes.telegram) telegramCount++;
      if (dispatchRes.pushNotification) pushCount++;
    }

    if (failures.length > 0) {
      this.logger.error(
        `⚠️ [BULK DISPATCH INCOMPLETE] ${failures.length} of ${matchedStores.length} stores ` +
          `could not be dispatched: ${failures.map((f) => f.storeName).join(', ')}`,
      );
    }

    // Nothing at all was written: that is a failure of the request, not a
    // successful dispatch of zero stores. Saying "0 tasks created" with a 200
    // would read as "the segmentation matched nothing", which is a different
    // and false statement.
    if (createdTasks.length === 0) {
      throw new HttpException(
        {
          success: false,
          error: 'DISPATCH_FAILED',
          message: `Heç bir tapşırıq yazıla bilmədi (${matchedStores.length} mağaza uyğun gəldi).`,
          failures,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    this.logger.log(
      `✅ [BULK DISPATCH COMPLETE] Created ${createdTasks.length} tasks. Dispatched ${telegramCount} Telegram and ${pushCount} Push notifications.`,
    );

    return {
      success: true,
      totalStoresMatched: matchedStores.length,
      tasksCreated: createdTasks.length,
      taskIds: createdTasks.map((t) => t.id),
      notificationsDispatched: {
        telegram: telegramCount,
        pushNotification: pushCount,
      },
      failures: failures.length > 0 ? failures : undefined,
    };
  }

  /**
   * Transitions a StoreTask to targetState according to strict state machine rules.
   * Throws 400 Bad Request on illegal transition.
   */
  async transitionTask(
    taskId: string,
    targetState: TaskState,
    principal: AuthenticatedPrincipal,
    notes?: string,
  ): Promise<StateTransitionResponseDto> {
    const task = db.getTask(taskId);
    if (!task) {
      throw new HttpException(`Tapşırıq tapılmadı (ID: ${taskId})`, HttpStatus.NOT_FOUND);
    }

    if (!db.canUserAccessTask(principal.userId, principal.role, taskId)) {
      throw new HttpException('Bu tapşırıq üçün icazə yoxdur', HttpStatus.FORBIDDEN);
    }

    const previousState = task.status;

    // 1. Strict State Machine Validation
    if (!isValidTransition(previousState, targetState)) {
      const allowed =
        ALLOWED_STATE_TRANSITIONS[previousState]?.join(', ') || 'NONE (Terminal State)';
      const errorMessage =
        `Qadağan olunmuş status keçidi: '${previousState}' -> '${targetState}'. ` +
        `Cari statusdan yalnız bu keçidlərə icazə verilir: [${allowed}].`;

      this.logger.warn(`❌ [INVALID TRANSITION BLOCKED] Task ${taskId}: ${errorMessage}`);

      // Log security / invalid transition attempt in audit log
      db.logAuditEvent({
        entityType: 'store_task',
        entityId: taskId,
        action: 'INVALID_TRANSITION_ATTEMPT',
        fromState: previousState,
        toState: targetState,
        actorId: principal.userId,
        payload: { error: errorMessage, notes },
      });

      throw new HttpException(
        {
          success: false,
          error: 'INVALID_STATE_TRANSITION',
          message: errorMessage,
          currentState: previousState,
          attemptedState: targetState,
          allowedTransitions: ALLOWED_STATE_TRANSITIONS[previousState],
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // 2. Perform State Update
    const updatedTask = db.updateTaskState(taskId, targetState);
    if (!updatedTask) {
      throw new HttpException(
        'Tapşırığın statusunu yeniləmək mümkün olmadı',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // 3. Record in Audit Log
    const auditEntry = db.logAuditEvent({
      entityType: 'store_task',
      entityId: taskId,
      action: 'STATE_TRANSITION',
      fromState: previousState,
      toState: targetState,
      actorId: principal.userId,
      payload: { notes, timestamp: new Date().toISOString() },
    });

    this.logger.log(
      `✅ [STATE TRANSITION] Task ${taskId}: ${previousState} -> ${targetState} (Actor: ${principal.userId})`,
    );

    // 4. Multi-Channel Notification Trigger on PUBLISHED
    let notificationResult: { telegram: boolean; pushNotification: boolean } | undefined;
    if (targetState === TaskState.PUBLISHED) {
      notificationResult = await this.notificationDispatcher.dispatchTaskPublished(
        updatedTask as unknown as StoreTask,
      );
    }

    return {
      success: true,
      taskId,
      previousState,
      currentState: targetState,
      updatedAt: updatedTask.updatedAt.toISOString(),
      auditLogId: auditEntry.id,
      notificationsDispatched: notificationResult,
    };
  }
}
