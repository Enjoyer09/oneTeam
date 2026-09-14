/**
 * oneTeam Retail Execution Platform — Domain Models & Entities
 */

import { TaskState } from './state-machine';

export enum UserRole {
  ADMIN = 'ADMIN',
  SUPERVISOR = 'SUPERVISOR',
  MERCHANDISER = 'MERCHANDISER',
  STORE_STAFF = 'STORE_STAFF',
}

export enum TaskPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  telegramChatId?: string | null;
  phone?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Region {
  id: string;
  name: string;
  code: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Store {
  id: string;
  storeCode: string;
  name: string;
  regionId: string;
  chainName: string;
  storeFormat: 'hypermarket' | 'supermarket' | 'express' | 'convenience';
  address: string;
  city: string;
  latitude: number;
  longitude: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Campaign {
  id: string;
  name: string;
  description: string;
  startDate: Date;
  endDate: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlanogramRule {
  sku: string;
  label: string;
  minFacings: number;
  shelfRow?: number;
}

export type ChecklistQuestionType = 'boolean' | 'number' | 'single_choice';

export interface ChecklistQuestion {
  id: string;
  question: string;
  type: ChecklistQuestionType;
  required: boolean;
  options?: string[];
  unit?: string;
  minValue?: number;
  maxValue?: number;
}

export interface ChecklistAnswer {
  questionId: string;
  value: boolean | number | string;
}

export interface TaskTemplate {
  id: string;
  campaignId?: string | null;
  title: string;
  description: string;
  referenceImageUrl: string;
  priority: TaskPriority;
  planogramRules: PlanogramRule[];
  requiresBeforeAfterPhoto?: boolean;
  checklistSchema?: ChecklistQuestion[];
  createdAt: Date;
  updatedAt: Date;
}

export interface StoreTask {
  id: string;
  templateId: string;
  storeId: string;
  assignedUserId?: string | null;
  status: TaskState;
  deadline: Date;
  publishedAt?: Date | null;
  deliveredAt?: Date | null;
  acknowledgedAt?: Date | null;
  submittedAt?: Date | null;
  reviewedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;

  // Joined relations
  template?: TaskTemplate;
  store?: Store;
  assignedUser?: User | null;
  evidences?: TaskEvidence[];
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectionItem {
  id: string;
  sku: string;
  label: string;
  confidence: number;
  box: BoundingBox;
  color: string;
  shelfRow?: number;
  facingIndex?: number;
}

export type EvidencePhotoType = 'before' | 'after' | 'standard';

export interface TaskEvidence {
  id: string;
  storeTaskId: string;
  submittedById: string;
  photoUrl: string;
  photoType?: EvidencePhotoType;
  checklistAnswers?: ChecklistAnswer[];
  latitude: number;
  longitude: number;
  gpsDistanceMeters: number;
  aiScore?: number | null;
  aiDetections?: DetectionItem[];
  aiSummary?: string | null;
  reviewerFeedback?: string | null;
  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditLog {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  fromState?: string | null;
  toState?: string | null;
  actorId?: string | null;
  payload?: Record<string, any> | null;
  createdAt: Date;
}

export interface GeoCoordinates {
  latitude: number;
  longitude: number;
}

/**
 * Calculates Haversine distance in meters between two GPS coordinates.
 */
export function calculateHaversineDistanceMeters(
  coord1: GeoCoordinates,
  coord2: GeoCoordinates,
): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = ((coord2.latitude - coord1.latitude) * Math.PI) / 180;
  const dLon = ((coord2.longitude - coord1.longitude) * Math.PI) / 180;

  const lat1 = (coord1.latitude * Math.PI) / 180;
  const lat2 = (coord2.latitude * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

export const GEOFENCE_MAX_DISTANCE_METERS = 100;

export interface GeofenceCheckResult {
  isWithinGeofence: boolean;
  distanceMeters: number;
  maxAllowedMeters: number;
  message: string;
}

export function checkStoreGeofence(
  userCoord: GeoCoordinates,
  storeCoord: GeoCoordinates,
  maxMeters = GEOFENCE_MAX_DISTANCE_METERS,
): GeofenceCheckResult {
  const distance = calculateHaversineDistanceMeters(userCoord, storeCoord);
  const isWithin = distance <= maxMeters;
  return {
    isWithinGeofence: isWithin,
    distanceMeters: distance,
    maxAllowedMeters: maxMeters,
    message: isWithin
      ? `✅ Məkân təsdiqləndi: Mağaza ərazisindəsiniz (${distance}m).`
      : `⚠️ Anti-fraud bloklama: Siz mağaza ərazisində deyilsiniz (Məsafə: ${distance}m). Maksimum icazə verilən məsafə ${maxMeters}m-dir.`,
  };
}
