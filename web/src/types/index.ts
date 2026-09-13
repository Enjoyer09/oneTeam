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
}

export type CocaColaSKU =
  | 'coca_cola_classic'
  | 'coca_cola_zero'
  | 'fanta'
  | 'sprite'
  | 'out_of_stock_gap';

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
