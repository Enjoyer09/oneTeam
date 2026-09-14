/**
 * oneTeam mobile field client — API data layer
 * ============================================================================
 *
 * WHAT THIS REPLACES
 * ------------------
 * `services/supabaseMobile.ts` was the last mock in the project. It held two
 * hardcoded stores, two hardcoded tasks, invented a storage URL on a
 * `mock-oneteam.supabase.co` host that does not exist, and produced the "AI
 * score" from `src/services/aiVision.ts` — a module that never opened a photo.
 * The app therefore worked perfectly against data nobody had entered, and would
 * have shown nothing real for a real store.
 *
 * It now talks to the Core API, over the same `/api/portal/field/*` endpoints the
 * Telegram bot uses. One data path for both field channels, so a store cannot
 * look like one thing in the chat and another in the app.
 *
 * HOW THE APP IDENTIFIES ITSELF
 * -----------------------------
 * The bot identifies the acting person by the Telegram chat an update came from.
 * A device has no chat, so it identifies them by the installation it was bound
 * on: `ONETEAM_DEVICE_ID`, bound through `POST /api/portal/field/bind`, which
 * also claims the store's open work exactly as the chat does.
 *
 * ⚠️ THE SERVICE CREDENTIAL IS IN THIS BUNDLE, AND THAT IS A KNOWN GAP.
 *
 * A mobile app is a client, so it should hold a per-user token, not the service
 * credential that the bot uses as a server. It holds one here because the app has
 * no login of its own yet and there is nothing else to authenticate with. Anyone
 * who extracts the bundle can act as the service account.
 *
 * What that means in practice: do not ship this build to a device outside the
 * pilot until `bind` returns a device-scoped token and this file sends that
 * instead. The change is small — one constant and one header — and the reason it
 * has not been made is that there is no login screen to issue the token yet. It
 * is written down here rather than left to be discovered.
 *
 * WHERE THE PHOTOS GO
 * -------------------
 * Nowhere durable. There is no object store configured for this project, so the
 * image travels as a `data:` URL and lands in the database. See the same note in
 * the bot's client and in `field.service.ts`.
 */

import {
  AuditMetadata,
  GPSCoordinates,
  MobileStore,
  MobileSubmission,
  MobileTask,
  SubmissionStatus,
  TaskPriority,
  TaskStatus,
} from '../types';

const env: Record<string, string | undefined> =
  typeof process !== 'undefined' && process.env ? process.env : {};

/** Same variable names the bot uses, so one deployment describes both channels. */
const API_BASE_URL = (
  env.ONETEAM_API_URL ||
  env.API_BASE_URL ||
  'http://localhost:3001'
).replace(/\/+$/, '');

const API_TOKEN = env.ONETEAM_API_TOKEN || 'oneteam-user:usr-admin-001';

/**
 * The identity of this installation.
 *
 * In a real React Native build this would come from persistent storage, minted
 * once on first launch. In this harness there is no storage layer, so it is
 * configuration — and it must be set, because two devices sharing a default id
 * would share one identity and one set of audits.
 *
 * Read per call rather than captured once, so a test can point it at its own
 * identity without reimporting the module.
 */
export function deviceId(): string {
  return (env.ONETEAM_DEVICE_ID || 'demo-device-01').trim();
}

const REQUEST_TIMEOUT_MS = 20_000;

/** Must not exceed `MAX_PHOTO_BYTES` in the API's field.service.ts. */
const MAX_PHOTO_BYTES = 1_500_000;

/**
 * A 1x1 JPEG, used only when the caller explicitly says it has no real capture.
 *
 * See `uploadPhoto`. It is a valid image rather than a string of zeros so
 * anything that later tries to decode it fails loudly instead of quietly
 * rendering nothing.
 */
const PLACEHOLDER_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

export class MobileApiError extends Error {
  /** null when the request never reached the API at all. */
  readonly status: number | null;
  readonly code: string | null;

  constructor(message: string, status: number | null = null, code: string | null = null) {
    super(message);
    this.name = 'MobileApiError';
    this.status = status;
    this.code = code;
  }

  /** True when the API could not be reached, as opposed to refusing the call. */
  get isUnreachable(): boolean {
    return this.status === null;
  }
}

type Envelope<T> = { success?: boolean; data?: T; message?: string | string[]; error?: string };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${API_BASE_URL}${path}`;
  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_TOKEN}`,
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new MobileApiError(
      `API-yə qoşulmaq mümkün olmadı (${API_BASE_URL}). Səbəb: ${reason}`,
      null,
      'API_UNREACHABLE'
    );
  }

  const text = await response.text();
  let payload: Envelope<T> = {};

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new MobileApiError(
          `API gözlənilməz cavab qaytardı (HTTP ${response.status})`,
          response.status,
          'BAD_RESPONSE'
        );
      }
    }
  }

  if (!response.ok) {
    const raw = (payload as any)?.message ?? (payload as any)?.error;
    const message = Array.isArray(raw) ? raw.join('; ') : raw;
    throw new MobileApiError(
      message || `API xətası (HTTP ${response.status})`,
      response.status,
      (payload as any)?.error ?? null
    );
  }

  return payload.data as T;
}

// ---------------------------------------------------------------------------
// Response shapes
//
// These mirror the API's `PanelStore` / `PanelTask` / `PanelSubmission`. They are
// declared here rather than imported because the API's panel shapes live inside
// the API application, not in `@oneteam/types`, and reaching into another
// package's internals would couple this client to its file layout.
// ---------------------------------------------------------------------------

interface ApiStore {
  id: string;
  store_code: string;
  name: string;
  address: string | null;
  city: string;
  latitude: number | null;
  longitude: number | null;
  is_active: boolean;
}

interface ApiTask {
  id: string;
  title: string;
  description: string;
  reference_image_url: string | null;
  priority: string;
  status: string;
  deadline: string;
  planogram_rules?: unknown[];
  checklist_schema?: unknown[];
}

interface ApiSubmission {
  id: string;
  task_id: string;
  store_id: string;
  photo_url: string;
  status: SubmissionStatus;
  reviewer_feedback: string | null;
  ai_score?: number | null;
  ai_summary?: string | null;
  submitted_at: string;
  metadata?: Record<string, unknown>;
}

function toMobileStore(store: ApiStore): MobileStore {
  return {
    id: store.id,
    store_code: store.store_code,
    name: store.name,
    address: store.address ?? null,
    city: store.city,
    latitude: typeof store.latitude === 'number' ? store.latitude : null,
    longitude: typeof store.longitude === 'number' ? store.longitude : null,
    is_active: store.is_active !== false,
  };
}

function toMobileTask(task: ApiTask): MobileTask {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    reference_image_url: task.reference_image_url ?? null,
    // The API already lower-cases the priority and collapses the eight-state
    // machine onto the panel's four, so these are pass-throughs rather than
    // conversions. They are typed narrowly to keep callers honest.
    priority: String(task.priority).toLowerCase() as TaskPriority,
    status: String(task.status).toLowerCase() as TaskStatus,
    deadline: task.deadline,
    planogram_rules: (task.planogram_rules ?? []) as MobileTask['planogram_rules'],
    checklist_schema: (task.checklist_schema ?? []) as MobileTask['checklist_schema'],
  };
}

function toMobileSubmission(submission: ApiSubmission): MobileSubmission {
  return {
    id: submission.id,
    task_id: submission.task_id,
    store_id: submission.store_id,
    photo_url: submission.photo_url,
    status: submission.status,
    reviewer_feedback: submission.reviewer_feedback ?? null,
    ai_score: submission.ai_score ?? null,
    ai_summary: submission.ai_summary ?? null,
    submitted_at: submission.submitted_at,
    metadata: submission.metadata ?? {},
    // The API has no column for this: a submission is "synced" the moment it is
    // accepted, and the queue only exists on the device.
    is_offline_synced: true,
  };
}

class MobilePortalApi {
  /** For startup logs. Never includes the token. */
  describeTarget(): string {
    return `${API_BASE_URL} (device ${deviceId()})`;
  }

  /** Confirms the API answers and the credential is accepted. */
  async ping(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await request<unknown>('/api/portal/stores');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Resolves a store code typed by a field worker. Null when no such store. */
  async getStoreByCode(storeCode: string): Promise<MobileStore | null> {
    const code = storeCode.trim().toUpperCase();
    if (!code) return null;

    const store = await request<ApiStore | null>(
      `/api/portal/field/store?code=${encodeURIComponent(code)}`
    );

    // A deactivated store must not accept audits even though it still resolves.
    if (!store || store.is_active === false) return null;
    return toMobileStore(store);
  }

  async getTasksForStore(storeId: string): Promise<MobileTask[]> {
    const tasks = await request<ApiTask[]>(
      `/api/portal/field/tasks?storeId=${encodeURIComponent(storeId)}`
    );
    return (tasks ?? []).map(toMobileTask);
  }

  /**
   * The audits this device has filed.
   *
   * The endpoint is keyed by actor, not by store, so the store filter happens
   * here. That is the right way round: a field worker's own history is what the
   * screen shows, and filtering server-side by store would hide an audit they
   * filed at a store they have since moved on from.
   */
  async getSubmissionsForStore(storeId: string, limit = 50): Promise<MobileSubmission[]> {
    const submissions = await request<ApiSubmission[]>(
      `/api/portal/field/submissions?deviceId=${encodeURIComponent(deviceId())}&limit=${limit}`
    );
    return (submissions ?? [])
      .map(toMobileSubmission)
      .filter((submission) => submission.store_id === storeId);
  }

  /** Every audit this device has filed, across stores. */
  async getAllSubmissions(limit = 50): Promise<MobileSubmission[]> {
    const submissions = await request<ApiSubmission[]>(
      `/api/portal/field/submissions?deviceId=${encodeURIComponent(deviceId())}&limit=${limit}`
    );
    return (submissions ?? []).map(toMobileSubmission);
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Links this device to a person, and claims the store's open work.
   *
   * `storeId` is what makes submission possible: the API refuses an audit from a
   * merchandiser who is not the task's assignee, and a device has no supervisor
   * to do the assigning. Passing the store records the claim. See
   * `FieldService.bind`.
   */
  async bindDevice(params: {
    fullName: string;
    storeId?: string;
  }): Promise<{ id: string; role: string; claimedTaskIds: string[] }> {
    const result = await request<{ id: string; role: string; claimedTaskIds?: string[] }>(
      '/api/portal/field/bind',
      {
        method: 'POST',
        body: JSON.stringify({
          deviceId: deviceId(),
          fullName: params.fullName,
          storeId: params.storeId,
        }),
      }
    );

    if (!result?.id) {
      throw new MobileApiError('İstifadəçi qeydiyyatı alınmadı', 500, 'BIND_FAILED');
    }
    return { id: result.id, role: result.role, claimedTaskIds: result.claimedTaskIds ?? [] };
  }

  /**
   * Tells the API the field worker has taken the task on.
   *
   * Without this the audit is unreviewable: the lifecycle only allows a review
   * from SUBMITTED, and a submission only advances a task that is already
   * ACKNOWLEDGED. The notification flow does this with a push and a tap; a
   * client that polls has to do it when the task is opened, which is the same
   * act. Idempotent and forward-only, so calling it twice is harmless.
   */
  async acknowledgeTask(
    taskId: string
  ): Promise<{ taskId: string; currentState: string; advanced: boolean }> {
    return await request<{ taskId: string; currentState: string; advanced: boolean }>(
      `/api/portal/field/tasks/${encodeURIComponent(taskId)}/acknowledge`,
      { method: 'POST', body: JSON.stringify({ deviceId: deviceId() }) }
    );
  }

  /**
   * Prepares a capture for submission.
   *
   * WHY THIS DOES NOT PRETEND TO HAVE A CAMERA
   * ------------------------------------------
   * There is no native camera module in this harness, so there is no real image
   * to read. Silently inventing bytes would put fabricated evidence in the
   * database — the exact failure the removed "AI score" had.
   *
   * So the caller has to say which it is:
   *
   *   - `base64` — a real capture, read from the device. What a shipping build
   *     passes.
   *   - `placeholder: true` — no capture is available and the caller knows it.
   *     Produces a 1x1 image and the submission records
   *     `photo_origin: 'placeholder'`, so nobody can mistake it for evidence.
   *
   * Passing neither throws. There is no third option where an image appears from
   * nowhere.
   */
  async uploadPhoto(params: {
    base64?: string;
    fileName: string;
    contentType?: string;
    placeholder?: boolean;
  }): Promise<{ photoUrl: string; origin: 'device' | 'placeholder' }> {
    const { fileName, contentType = 'image/jpeg', base64, placeholder } = params;

    if (!base64 && !placeholder) {
      throw new MobileApiError(
        `Foto məlumatı yoxdur (${fileName}). Bu mühitdə kamera modulu yoxdur — ` +
          `zəhmət olmasa real cihazdan çəkilmiş şəkil ötürün.`,
        400,
        'CAPTURE_NOT_AVAILABLE'
      );
    }

    const payload = base64 ?? PLACEHOLDER_JPEG_BASE64;
    const dataUrl = `data:${contentType};base64,${payload}`;

    if (dataUrl.length > MAX_PHOTO_BYTES) {
      throw new MobileApiError(
        `Şəkil çox böyükdür (${Math.round(dataUrl.length / 1024)} KB). ` +
          `Maksimum ${Math.round(MAX_PHOTO_BYTES / 1024)} KB qəbul edilir.`,
        413,
        'PHOTO_TOO_LARGE'
      );
    }

    return { photoUrl: dataUrl, origin: base64 ? 'device' : 'placeholder' };
  }

  /**
   * Files a shelf audit.
   *
   * Unlike the Telegram channel, this one has a real GPS fix from the device, so
   * the geofence check genuinely runs — which is the point of having the mobile
   * client at all. `locationUnverified` is only sent when the caller has no fix,
   * and the API records that as weaker evidence rather than substituting the
   * store's own coordinates.
   */
  async submitAudit(params: {
    taskId: string;
    storeId: string;
    photoUrl: string;
    photoOrigin?: 'device' | 'placeholder';
    gps?: GPSCoordinates;
    distanceFromStoreMeters?: number;
    metadata?: AuditMetadata;
    checklistAnswers?: Array<{ questionId: string; value: boolean | number | string }>;
  }): Promise<MobileSubmission> {
    const hasFix =
      typeof params.gps?.latitude === 'number' && typeof params.gps?.longitude === 'number';

    const result = await request<ApiSubmission>('/api/portal/field/submissions', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: deviceId(),
        storeTaskId: params.taskId,
        photoUrl: params.photoUrl,
        photoType: 'standard',
        latitude: hasFix ? params.gps!.latitude : undefined,
        longitude: hasFix ? params.gps!.longitude : undefined,
        locationUnverified: !hasFix,
        checklistAnswers: params.checklistAnswers ?? [],
        metadata: {
          ...(params.metadata ?? {}),
          device_id: deviceId(),
          photo_origin: params.photoOrigin ?? 'device',
          distance_from_store_meters: params.distanceFromStoreMeters,
          storage: 'inline-data-url',
        },
      }),
    });

    if (!result?.id) {
      throw new MobileApiError('Audit qeydə alınmadı', 500, 'SUBMISSION_FAILED');
    }

    return toMobileSubmission(result);
  }
}

export const mobileApi = new MobilePortalApi();
