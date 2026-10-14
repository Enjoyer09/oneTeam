export type UserRole = 'admin' | 'supervisor' | 'store_staff' | 'merchandiser';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskStatus = 'draft' | 'published' | 'completed' | 'archived';
export type SubmissionStatus = 'pending_review' | 'approved' | 'rejected';

/**
 * A checklist question in the panel's own vocabulary.
 *
 * The panel's `Task` carries the template's checklist, and the editor renders it
 * with one-tap answer buttons. The API's canonical shape is `ChecklistQuestion`
 * in `@oneteam/types`; the web portal deliberately does not depend on that
 * package (see `web/src/lib/clock.ts` for the same reasoning), so this is the
 * panel-side mirror. `label` is the field the API actually writes.
 */
export interface ChecklistItem {
  id: string;
  label: string;
  type: 'boolean' | 'single_choice' | 'number' | 'text';
  /** Only meaningful for `single_choice`; the one-tap answer buttons. */
  options?: string[];
}

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

/** SKU kataloqu (dalğa 1.2) — barkod → məhsul identiteti. */
export interface Product {
  id: string;
  barcode: string;
  name: string;
  size: string | null;
  variant: string | null;
  created_at: string;
}

/** Rəf xəritəsi mövqesi (dalğa 1.3). `product_id` null = boş mövqe. */
export interface ShelfPosition {
  id: string;
  section: string;
  level: number;
  position: number;
  product_id: string | null;
  /**
   * Ən son əl sayımı (dalğa 1.4): 0 = sayılıb, məhsul yoxdur;
   * null = hələ heç kim saymayıb — OSA bu ikini fərqləndirir.
   */
  units: number | null;
  counted_at: string | null;
  created_at: string;
}

/** Bir bölmənin sayğac payı (share of shelf), faizlə. */
export interface ShelfProductShare {
  product_id: string;
  name: string;
  units: number;
  share: number;
}

export interface ShelfSectionMetric {
  section: string;
  assigned: number;
  present: number;
  units: number;
  products: ShelfProductShare[];
}

/** Manual OSA / share of shelf (dalğa 1.4) — server hesablayır. */
export interface ShelfMetrics {
  assigned_slots: number;
  counted_slots: number;
  present_slots: number;
  /** present/counted, 0–100; null = hələ heç nə sayılmayıb. */
  osa: number | null;
  total_units: number;
  sections: ShelfSectionMetric[];
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
  checklist_schema?: ChecklistItem[];

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
  sku: CocaColaSKU | 'unverified_bottle';
  label: string;
  confidence: number;
  box: BoundingBox;
  color: string;
  shelfRow: number;
  facingIndex: number;
  objectClass?: string;
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
    /** The vision engine's own report, when one ran. Shape belongs to the engine. */
    ai_evaluation?: Record<string, unknown>;
    [key: string]: unknown;
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
