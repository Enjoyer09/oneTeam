/**
 * TypeScript Type Definitions for oneTeam Shelf Monitoring Platform
 * Database Schema: PostgreSQL / Supabase
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type UserRole = 'admin' | 'supervisor' | 'store_staff' | 'merchandiser';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskStatus = 'draft' | 'published' | 'completed' | 'archived';
export type SubmissionStatus = 'pending_review' | 'approved' | 'rejected';

export interface SubmissionMetadata {
  gps?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
  telegram?: {
    chat_id: number;
    message_id: number;
    username?: string;
  };
  device?: {
    model?: string;
    os?: string;
    app_version?: string;
  };
  capture_timestamp?: string;
  [key: string]: unknown;
}

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          full_name: string | null;
          role: UserRole;
          telegram_chat_id: number | null;
          phone_number: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          full_name?: string | null;
          role?: UserRole;
          telegram_chat_id?: number | null;
          phone_number?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          full_name?: string | null;
          role?: UserRole;
          telegram_chat_id?: number | null;
          phone_number?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      stores: {
        Row: {
          id: string;
          store_code: string;
          name: string;
          address: string | null;
          city: string;
          latitude: number | null;
          longitude: number | null;
          is_active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          store_code: string;
          name: string;
          address?: string | null;
          city?: string;
          latitude?: number | null;
          longitude?: number | null;
          is_active?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          store_code?: string;
          name?: string;
          address?: string | null;
          city?: string;
          latitude?: number | null;
          longitude?: number | null;
          is_active?: boolean;
          created_at?: string;
        };
      };
      tasks: {
        Row: {
          id: string;
          title: string;
          description: string;
          reference_image_url: string | null;
          priority: TaskPriority;
          status: TaskStatus;
          deadline: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          title: string;
          description: string;
          reference_image_url?: string | null;
          priority?: TaskPriority;
          status?: TaskStatus;
          deadline: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          title?: string;
          description?: string;
          reference_image_url?: string | null;
          priority?: TaskPriority;
          status?: TaskStatus;
          deadline?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      task_assignments: {
        Row: {
          id: string;
          task_id: string;
          store_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          task_id: string;
          store_id: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          task_id?: string;
          store_id?: string;
          created_at?: string;
        };
      };
      submissions: {
        Row: {
          id: string;
          task_id: string;
          store_id: string;
          submitted_by: string | null;
          photo_url: string;
          status: SubmissionStatus;
          reviewer_feedback: string | null;
          ai_score: number | null;
          ai_detections: Json;
          ai_summary: string | null;
          metadata: SubmissionMetadata | Json;
          submitted_at: string;
          reviewed_at: string | null;
        };
        Insert: {
          id?: string;
          task_id: string;
          store_id: string;
          submitted_by?: string | null;
          photo_url: string;
          status?: SubmissionStatus;
          reviewer_feedback?: string | null;
          ai_score?: number | null;
          ai_detections?: Json;
          ai_summary?: string | null;
          metadata?: SubmissionMetadata | Json;
          submitted_at?: string;
          reviewed_at?: string | null;
        };
        Update: {
          id?: string;
          task_id?: string;
          store_id?: string;
          submitted_by?: string | null;
          photo_url?: string;
          status?: SubmissionStatus;
          reviewer_feedback?: string | null;
          ai_score?: number | null;
          ai_detections?: Json;
          ai_summary?: string | null;
          metadata?: SubmissionMetadata | Json;
          submitted_at?: string;
          reviewed_at?: string | null;
        };
      };
    };
  };
}
