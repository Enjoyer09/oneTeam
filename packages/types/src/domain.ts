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

export type ChecklistQuestionType = 'boolean' | 'number' | 'single_choice' | 'text';

export interface ChecklistQuestion {
  id: string;

  /**
   * The question's text.
   *
   * OPEN CONTRACT DEFECT — TASK #73
   * -------------------------------
   * The API stores and returns a question under `label` and never sets
   * `question`, so at runtime this field is absent for every question authored
   * in the panel. It is declared OPTIONAL because that is the truth: a required
   * field that is never present is a type that hides a defect instead of
   * catching one, and this one hid it for two phases.
   *
   * Whether `label` is renamed to `question` (with a backfill) or `label` is
   * canonical and this field is deleted is still undecided — see #73. Until
   * then, readers must accept both; `handlers/taskFlow.ts:questionText` is the
   * single place that does.
   */
  question?: string;

  /** The name the API uses today. See `question` and #73. */
  label?: string;

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

/**
 * Where a chat is in the guided field flow.
 *
 * WHY THIS IS HERE AND NOT IN THE BOT
 * -----------------------------------
 * It was declared in `src/bot/types.ts`, which was fine while only the bot knew
 * about it. It is not fine now: the API validates the step it is asked to store,
 * so the list has to exist somewhere both can see. Two copies of a state enum
 * drift the first time one of them gains a state, and the symptom is a step the
 * bot happily enters and the API refuses to save — which presents to the
 * merchandiser as "the bot stopped working halfway through".
 *
 * The steps are named for what the bot is *waiting for*, not for what it just
 * did, because that is what decides which incoming message belongs to the flow.
 * `awaiting_checklist` covers every question in the checklist rather than one
 * step per question: which question is current is a cursor (`checklistIndex`),
 * not a state.
 */
export const BOT_STEPS = [
  'idle',
  'awaiting_store_code',
  'awaiting_location',
  'awaiting_checklist',
  'awaiting_photo',
  /**
   * The photo has arrived and the bot is showing what it captured, waiting for
   * the merchandiser to accept it. The file is not downloaded until they do, so
   * a bad shot costs a re-shoot rather than a wrong audit in a supervisor's
   * queue.
   */
  'awaiting_confirm',
] as const;

export type BotStep = (typeof BOT_STEPS)[number];

/** True when `value` is a step this system knows how to be in. */
export function isBotStep(value: unknown): value is BotStep {
  return typeof value === 'string' && (BOT_STEPS as readonly string[]).includes(value);
}
