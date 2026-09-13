import { Context, SessionFlavor } from 'grammy';
import { Database, UserRole, TaskPriority, TaskStatus, SubmissionStatus } from '../../types/database.types';

export interface SessionData {
  step?: 'idle' | 'awaiting_store_code' | 'awaiting_photo';
  storeId?: string;
  storeCode?: string;
  storeName?: string;
  profileId?: string;
  activeTaskId?: string;
  activeTaskTitle?: string;
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
  submitted_at: string;
  task?: {
    title: string;
  };
  store?: {
    name: string;
    store_code: string;
  };
}
