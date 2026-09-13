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
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp: string;
}
