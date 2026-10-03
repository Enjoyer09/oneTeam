export type UserRole = 'admin' | 'supervisor' | 'store_staff' | 'merchandiser';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskStatus = 'draft' | 'published' | 'completed' | 'archived';
export type SubmissionStatus = 'pending_review' | 'approved' | 'rejected';

export interface Store {
  id: string;
  store_code: string;
  name: string;
  chain_name?: string;
  store_format?: string;
  region_id?: string;
  address: string | null;
  city: string;
  latitude: number | null;
  longitude: number | null;
  is_active: boolean;
  created_at: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  reference_image_url: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  deadline: string;
  created_by?: string | null;
  created_at: string;
  updated_at?: string;
  assigned_stores?: string[]; // Array of store IDs
  requires_before_after_photo?: boolean;
  checklist_schema?: any[];

  /**
   * The ids an edit or delete needs.
   *
   * A panel task is a projection of one `store_tasks` row. Its deadline and
   * assignee live on that row; its title, description, priority and checklist
   * live on the template it was dispatched from, which every other store that
   * received the same briefing also reads. The panel cannot infer either id
   * from what it renders, so the API states them.
   */
  template_id?: string;
  store_id?: string;
  assigned_user_id?: string | null;

  /**
   * The kind of work, derived by the API from the fields that exist.
   *
   * There is no `task_type` column: a checklist means the template has a
   * checklist, a photo comparison means it requires a before/after pair, and
   * anything else is a plain audit. Computed, so it cannot drift.
   */
  kind?: 'CHECKLIST' | 'PHOTO' | 'AUDIT';

  /** How many store tasks share this task's template. */
  sibling_task_count?: number;

  /** Submissions against this task. A task with any cannot be deleted. */
  evidence_count?: number;
}

export type CocaColaSKU =
  'coca_cola_classic' | 'coca_cola_zero' | 'fanta' | 'sprite' | 'out_of_stock_gap';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectionItem {
  id: string;
  sku: CocaColaSKU;
  label: string;
  confidence: number;
  box: BoundingBox;
  color: string;
  shelfRow: number;
  facingIndex: number;
}

export interface Submission {
  id: string;
  task_id: string;
  store_id: string;
  submitted_by?: string | null;
  photo_url: string;
  photo_type?: 'before' | 'after' | 'standard';
  before_photo_url?: string | null;
  checklist_answers?: Array<{
    questionId: string;
    question?: string;
    value: boolean | number | string;
    unit?: string;
  }>;
  status: SubmissionStatus;
  /**
   * The device flagged this fix as mock/simulated (spoofed GPS). Held for
   * mandatory review; approving it is a deliberate supervisor override.
   */
  location_mocked?: boolean;
  /** No real fix was captured (Telegram skip / declined prompt). Weaker
   *  evidence, not a fraud finding — so it is styled as a caution, not a fault. */
  location_unverified?: boolean;
  reviewer_feedback: string | null;
  ai_score?: number | null;
  ai_detections?: DetectionItem[];
  ai_summary?: string | null;
  metadata: {
    telegram_user_id?: number;
    telegram_username?: string;
    message_id?: number;
    captured_at?: string;
    gps?: {
      latitude: number;
      longitude: number;
    };
    ai_evaluation?: any;
    [key: string]: any;
  };
  submitted_at: string;
  reviewed_at: string | null;
  // Joins
  task?: Task;
  store?: Store;
  submitter_name?: string;
}

export interface DashboardMetrics {
  totalStores: number;
  activeTasks: number;
  pendingReviews: number;
  complianceRate: number; // percentage (0 - 100)
}
