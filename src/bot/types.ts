import { Context, SessionFlavor } from 'grammy';
import { ChecklistAnswer, ChecklistQuestion } from '@oneteam/types';
import { Database, UserRole, TaskPriority, TaskStatus, SubmissionStatus } from '../../types/database.types';

/**
 * Where the chat is in the guided field flow.
 *
 * The three steps between "the merchandiser picked a task" and "the photo is
 * filed" are separate states because each one waits for a different kind of
 * message — a location, a text answer, a callback tap, a photo. A single
 * `awaiting_photo` state could not tell them apart.
 */
export type BotStep =
  | 'idle'
  | 'awaiting_store_code'
  | 'awaiting_location'
  | 'awaiting_checklist'
  | 'awaiting_photo';

export interface SessionData {
  step?: BotStep;
  storeId?: string;
  storeCode?: string;
  storeName?: string;
  profileId?: string;
  activeTaskId?: string;
  activeTaskTitle?: string;

  /**
   * The coordinates the merchandiser shared for the task in progress.
   *
   * Absent when they skipped the prompt, which is the only honest way to send a
   * submission without a location: the API is told `locationUnverified` and
   * records a `GEOFENCE_NOT_VERIFIED` event. Never filled in from the store's
   * own coordinates — that would make the geofence pass for everyone.
   */
  location?: { latitude: number; longitude: number };

  /** The template's questions, copied onto the session when the task is opened. */
  checklistQuestions?: ChecklistQuestion[];

  /** Answers collected so far. Sent with the photo. */
  checklistAnswers?: ChecklistAnswer[];

  /** Index into `checklistQuestions` of the question being asked right now. */
  checklistIndex?: number;
}

export type BotContext = Context & SessionFlavor<SessionData>;

export interface StoreRecord {
  id: string;
  store_code: string;
  name: string;
  address: string | null;
  city: string;
  is_active: boolean;
}

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  reference_image_url: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  deadline: string;

  /**
   * The template's checklist, as stored.
   *
   * The API has always returned this (it is `PanelTask.checklist_schema`) and
   * the bot used to drop it on the floor — which is why every chat submission
   * arrived with no answers and had to be flagged as such. Asking the questions
   * needs the questions, so the field is declared here.
   */
  checklist_schema?: ChecklistQuestion[];

  requires_before_after_photo?: boolean;
}

export interface SubmissionRecord {
  id: string;
  task_id: string;
  store_id: string;
  photo_url: string;
  status: SubmissionStatus;
  reviewer_feedback: string | null;
  ai_score?: number | null;
  ai_detections?: any;
  ai_summary?: string | null;
  metadata?: Record<string, unknown>;

  /**
   * The answers that were filed with the audit.
   *
   * Read back by `/mystatus` and by the end-to-end test to prove the checklist
   * the flow collected actually reached the record, rather than being gathered
   * in the chat and dropped on the way to the API.
   */
  checklist_answers?: Array<{ questionId: string; value: unknown }>;

  submitted_at: string;
  task?: {
    title: string;
  };
  store?: {
    name: string;
    store_code: string;
  };
}
