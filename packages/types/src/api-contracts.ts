/**
 * oneTeam Retail Execution Platform — API Contracts & Payloads
 */

import { TaskState } from './state-machine';
import {
  TaskEvidence,
  StoreTask,
  Store,
  TaskTemplate,
  BotStep,
  ChecklistAnswer,
  ChecklistQuestion,
} from './domain';

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
    outcome: NotificationOutcome;
  };
}

/**
 * What the API managed to record for delivery — not what was delivered.
 *
 * WHY THIS REPLACED A BOOLEAN PAIR
 * --------------------------------
 * The field it replaces was `{ telegram: boolean; pushNotification: boolean }`,
 * and both members were returned as `true` unconditionally, from a service that
 * pushed a payload into an in-memory array and sent nothing. The array was
 * emptied on every deploy. A caller reading `telegram: true` was told a message
 * had gone out when no message existed anywhere.
 *
 * The names below describe what the API actually knows at the moment it
 * answers: it wrote a row, or the row was already there, or it wrote a row that
 * nothing can ever send, or there was no database to write to at all. Whether
 * the message reached Telegram is decided later, by the bot, and is observable
 * only from the outbox — see `GET /api/portal/field/notifications`.
 */
export type NotificationOutcome =
  /** A row is in the outbox; the bot will pick it up. */
  | 'queued'
  /** The same event was already in the outbox. Nothing was written twice. */
  | 'already-queued'
  /**
   * A row is in the outbox with no `chat_id`: the assignee has never spoken to
   * the bot, so there is nowhere to send this. Kept rather than dropped so the
   * gap is visible instead of looking like nothing happened.
   */
  | 'no-recipient'
  /** The process has no database connection, so there is no outbox at all. */
  | 'no-queue';

/**
 * Counts of what a bulk dispatch recorded. See `NotificationOutcome`.
 *
 * There is no `pushNotification` counterpart: the platform has no push path.
 * The mobile client is a headless control layer with no notification permission
 * and no device-token registration — the APNs payload this used to count was
 * invented, and a number is a poor place to keep an invention.
 */
export interface NotificationDispatchSummary {
  queued: number;
  alreadyQueued: number;
  withoutRecipient: number;
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
  notificationsDispatched: NotificationDispatchSummary;
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

/**
 * Where a chat is in the guided field flow, as it travels over the wire.
 *
 * WHY THIS IS A SHARED CONTRACT AND NOT TWO LOCAL SHAPES
 * ------------------------------------------------------
 * The bot stores this and the API validates and persists it. If each side had
 * its own interface they would agree until one of them was edited, and the
 * failure mode is not a compile error — it is a field the bot writes that the
 * API silently drops, so a resumed flow is missing a piece of what it had.
 *
 * The shape is deliberately flat and primitive: it crosses a JSON boundary in
 * both directions, so nothing here may depend on a class, a `Date`, or an
 * undefined-versus-missing distinction.
 */
export interface FieldFlowPayload {
  step: BotStep;

  /** The person this chat is bound to, once it is bound. Null before that. */
  userId?: string | null;

  storeId?: string | null;
  storeCode?: string | null;
  storeName?: string | null;

  activeTaskId?: string | null;
  activeTaskTitle?: string | null;

  /**
   * The merchandiser's own fix, or null when they skipped the prompt.
   *
   * Null is a *statement*, not an absence: it means the audit will be recorded
   * as location-unverified. The store's own coordinates must never be put here
   * — see `createSubmission` for why.
   */
  location?: { latitude: number; longitude: number } | null;

  /** The questions the flow started with, so a resumed flow asks the same ones. */
  checklistQuestions?: ChecklistQuestion[];

  checklistAnswers?: ChecklistAnswer[];
  checklistIndex?: number | null;

  /**
   * A photo the merchandiser has sent and not yet confirmed.
   *
   * Only Telegram's `file_id` is held; the bytes are not fetched until the
   * confirm button is pressed. A merchandiser who re-shoots costs a discarded
   * id rather than a downloaded file and a wrong audit.
   */
  pendingPhoto?: {
    fileId: string;
    width?: number;
    height?: number;
    fileSize?: number;
    /** The chat message carrying the photo, so the bot can act on it later. */
    messageId?: number;
  } | null;
}
