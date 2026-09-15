/**
 * oneTeam Retail Execution Platform — API Contracts & Payloads
 */

import { TaskState } from './state-machine';
import { TaskEvidence, StoreTask, Store, TaskTemplate } from './domain';

export interface StateTransitionRequestDto {
  targetState: TaskState;
  actorId?: string;
  notes?: string;
  metadata?: Record<string, any>;
}

export interface StateTransitionResponseDto {
  success: boolean;
  taskId: string;
  previousState: TaskState;
  currentState: TaskState;
  updatedAt: string;
  auditLogId: string;
  notificationsDispatched?: {
    telegram: boolean;
    pushNotification: boolean;
  };
}

export interface TelegramInlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramNotificationPayload {
  chatId: string | number;
  text: string;
  parseMode?: 'MarkdownV2' | 'HTML' | 'Markdown';
  replyMarkup?: {
    inline_keyboard: TelegramInlineButton[][];
  };
}

export interface PushNotificationPayload {
  to: string; // Device token or user topic
  title: string;
  body: string;
  badge?: number;
  sound?: string;
  data: {
    taskId: string;
    storeId: string;
    type: 'TASK_PUBLISHED' | 'TASK_REMINDER' | 'AUDIT_REVIEWED';
    deepLink: string;
    [key: string]: any;
  };
}

export interface TelegramWebhookCallbackQuery {
  id: string;
  from: {
    id: number;
    first_name: string;
    username?: string;
  };
  message?: {
    message_id: number;
    chat: {
      id: number;
    };
  };
  data: string; // e.g., "ack_task_123"
}

export interface TelegramWebhookUpdate {
  update_id: number;
  callback_query?: TelegramWebhookCallbackQuery;
  message?: any;
}

export interface SubmitEvidenceRequestDto {
  storeTaskId: string;
  photoUrl: string;
  photoType?: 'before' | 'after' | 'standard';
  checklistAnswers?: import('./domain').ChecklistAnswer[];
  latitude: number;
  longitude: number;
  /**
   * The caller states that this channel could not collect the checklist.
   *
   * Only the Telegram bot sets this: it submits a photo without ever asking the
   * template's questions, and without this flag every task carrying a required
   * question is refused with a 400 — which is every real task in the catalogue.
   *
   * It is an explicit assertion rather than a silent bypass, and the service
   * writes a `CHECKLIST_NOT_COLLECTED` audit event naming the unanswered
   * questions, so a supervisor can see the gap instead of assuming the answers
   * were fine. The mobile client does not set it and keeps the full check.
   */
  checklistNotCollected?: boolean;
  aiScore?: number;
  aiDetections?: any[];
  aiSummary?: string;
}

export interface BulkDispatchDto {
  templateId: string;
  deadline: string;
  assignedUserId?: string;
  regionId?: string;
  chainName?: string;
  storeFormat?: string;
}

export interface BulkDispatchResultDto {
  success: boolean;
  totalStoresMatched: number;
  tasksCreated: number;
  taskIds: string[];
  notificationsDispatched: {
    telegram: number;
    pushNotification: number;
  };
  /**
   * Stores the briefing could not be dispatched to, and why.
   *
   * Present because `tasksCreated` alone cannot distinguish "the segmentation
   * matched twelve stores and all twelve succeeded" from "twelve matched, nine
   * were written and three failed". A supervisor who is told only the first
   * number will believe the shelves are covered when they are not.
   */
  failures?: Array<{ storeId: string; storeName: string; reason: string }>;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp: string;
}
