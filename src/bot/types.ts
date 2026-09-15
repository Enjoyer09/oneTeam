import { Context, SessionFlavor } from 'grammy';
import {
  BotStep,
  ChecklistAnswer,
  ChecklistQuestion,
  TaskPriority,
  TaskState,
} from '@oneteam/types';

/**
 * The verdict a supervisor gave an audit.
 *
 * Declared here rather than imported, because it is not a domain state: it is
 * how the portal presents a review outcome, and it is what
 * `PanelSubmission.status` actually carries.
 *
 * WHY THIS FILE NO LONGER IMPORTS FROM `types/database.types.ts`
 * -------------------------------------------------------------
 * That file described the Supabase schema — lowercase literals such as
 * `'draft' | 'published' | 'completed' | 'archived'` — and the bot's task
 * record was typed with them. The API returns the domain states instead:
 * `'PUBLISHED'`, `'ACKNOWLEDGED'`, `'SUBMITTED'`. So `TaskRecord.status` was
 * typed as a set of values it could never hold, and every comparison against a
 * real state was unchecked. It survived because the API client asserts its
 * response type rather than validating it, so nothing ever compared the two.
 *
 * The types now come from the same package the API does. `SubmissionStatus` is
 * the one exception, and it is declared here rather than deleted because the
 * portal's review vocabulary genuinely differs from the task state machine.
 */
export type SubmissionStatus = 'pending_review' | 'approved' | 'rejected';

/**
 * Where the chat is in the guided field flow.
 *
 * IMPORTED, NOT DECLARED HERE, SINCE THE FLOW BECAME PERSISTENT
 * ------------------------------------------------------------
 * This union used to live in this file. Now that the API stores the flow, the
 * API also has to decide whether the step it is asked to save is one it knows
 * about — so the union moved to `@oneteam/types`, and both sides read the same
 * copy. `SessionData.step` below is typed with it.
 *
 * Two copies of a state enum drift the first time one of them gains a state, and
 * this particular drift is silent: the bot enters a step the API refuses to
 * store, every write fails, and the merchandiser watches the flow start over at
 * the same question. One copy removes the possibility rather than the symptom.
 *
 * The steps between "the merchandiser picked a task" and "the photo is filed"
 * are separate states because each one waits for a different kind of message — a
 * location, a text answer, a callback tap, a photo. A single `awaiting_photo`
 * state could not tell them apart.
 */

/**
 * What the bot remembers about a chat between two updates.
 *
 * This is the shape grammy's session middleware reads and writes, so it is also
 * the shape `ApiSessionStorage` sends to `/api/portal/field/flow`. The two must
 * stay in step, and the translation between them lives in one place —
 * `sessionStorage.ts` — so that it can only be got wrong once.
 */
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

  /**
   * A photo the merchandiser has sent and not yet confirmed.
   *
   * Only Telegram's `file_id` is held here. The bytes are not fetched from
   * Telegram and no submission is filed until the confirm button is pressed, so
   * a bad shot costs a re-shoot rather than a wrong audit sitting in a
   * supervisor's queue waiting to be rejected.
   */
  pendingPhoto?: {
    fileId: string;
    width?: number;
    height?: number;
    fileSize?: number;
    messageId?: number;
  };
}

export type BotContext = Context & SessionFlavor<SessionData>;

/**
 * Answers the callback query that triggered the current update, at most once.
 *
 * Telegram shows the button spinning until its query is answered, and answering
 * the same query twice is a 400. Both of those are the router's problem, not a
 * handler's, so the router hands each handler a function that closes over the
 * "already answered" flag and swallows the error if the query expired. A handler
 * calls `answer()` when the tap worked and `answer('...')` when it needs to say
 * why nothing happened; it never has to know whether it was the first caller.
 */
export type AnswerCallback = (toast?: string) => Promise<void>;

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
  status: TaskState;
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

/**
 * A message the API has queued for a chat, leased to this bot process.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a push notification. The bot polls for these and sends them with the
 * ordinary Telegram API; there is no push channel in this deployment and the
 * mobile client has no registration for one.
 *
 * `body` is plain text, not Markdown. It is assembled by the API from a
 * supervisor's free text, and Telegram's legacy Markdown rejects a whole message
 * over a single unmatched `*` — so the API sends none and the bot must not add
 * `parse_mode`. See `NotificationDispatcherService`.
 *
 * `taskId` is what the "open" button needs. It is null when the message is not
 * about one task, and the button is then left off rather than pointed at
 * nothing.
 */
export interface PendingNotification {
  id: string;
  chatId: string;
  kind: 'TASK_ASSIGNED' | 'TASK_REJECTED' | 'DEADLINE_SOON';
  title: string;
  body: string;
  taskId: string | null;
  createdAt: string;
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
