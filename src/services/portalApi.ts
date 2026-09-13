/**
 * oneTeam — API client for the Telegram bot
 * ============================================================================
 *
 * WHAT THIS REPLACES
 * ------------------
 * This file replaces `src/services/supabase.ts`, which was a mock wearing a
 * real client's clothes. It fell back to `https://mock-oneteam.supabase.co`
 * whenever `SUPABASE_URL` was unset — which it always was — and answered every
 * call from an in-memory array. The bot therefore worked perfectly against two
 * invented stores and one invented task, and would have reported "no tasks" for
 * every real one.
 *
 * It now talks to the Core API over HTTP. One data path, shared with the
 * supervisor panel, so a store cannot look like one thing in the bot and
 * another in the panel.
 *
 * WHICH CREDENTIAL, AND WHY IT IS NOT THE USER'S
 * ----------------------------------------------
 * The bot is a server: one process serves every chat, so it cannot hold a
 * per-user token. It authenticates with a single service credential
 * (`ONETEAM_API_TOKEN`) and identifies the acting person by sending the chat id
 * the update arrived from.
 *
 * That is only safe because the credential is unreachable by a chat. A Telegram
 * user cannot call the API — they can only ask the bot to, and the bot derives
 * the chat id from the update it is handling rather than from anything the
 * caller typed. Callers must keep it that way: never accept a chat id that did
 * not come from `ctx`.
 *
 * WHERE THE PHOTOS GO
 * -------------------
 * Nowhere durable yet, and this is the honest weak point of the channel.
 *
 * There is no object store configured for this project, so `uploadShelfPhoto`
 * returns a `data:` URL and the image travels inline in the submission. Telegram
 * compresses field photos to roughly 50-150 KB, which base64 inflates by about a
 * third, so it fits inside the API's 1.5 MB cap with room to spare.
 *
 * It will not survive a thousand stores submitting daily: every database backup
 * would carry every photo, and listing evidences would drag megabytes through
 * the connection. The fix is object storage with only the URL stored here. The
 * size check below exists so the wrong answer cannot grow without bound before
 * that happens.
 */

import dotenv from 'dotenv';
import { StoreRecord, TaskRecord, SubmissionRecord } from '../bot/types';

dotenv.config();

/**
 * Where the API lives.
 *
 * `ONETEAM_API_URL` is the deliberate name. On Railway the bot reaches the API
 * over the private network (`http://api.railway.internal:3001`), which never
 * leaves the platform; the public hostname would work too but would send every
 * audit photo across the internet for no reason.
 */
const API_BASE_URL = (
  process.env.ONETEAM_API_URL ||
  process.env.API_BASE_URL ||
  'http://localhost:3001'
).replace(/\/+$/, '');

/**
 * The service credential, in the API's `oneteam-user:<userId>` form.
 *
 * The default names the seeded admin so a fresh local checkout works without
 * configuration. Production sets it explicitly, which is also what makes it
 * rotatable without rebuilding the image.
 */
const API_TOKEN = process.env.ONETEAM_API_TOKEN || 'oneteam-user:usr-admin-001';

/** Long enough for a cold container, short enough that a chat is never left hanging. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Must not exceed `MAX_PHOTO_BYTES` in
 * `apps/api/src/modules/portal/field.service.ts`.
 *
 * Checked here as well as there so an oversized photo fails with a sentence a
 * merchandiser can act on, instead of an HTTP 413 they cannot see.
 */
const MAX_PHOTO_BYTES = 1_500_000;

export class PortalApiError extends Error {
  /** null when the request never reached the API at all. */
  readonly status: number | null;
  readonly code: string | null;

  constructor(message: string, status: number | null = null, code: string | null = null) {
    super(message);
    this.name = 'PortalApiError';
    this.status = status;
    this.code = code;
  }

  /** True when the API could not be reached, as opposed to refusing the call. */
  get isUnreachable(): boolean {
    return this.status === null;
  }
}

type Envelope<T> = { success?: boolean; data?: T; message?: string; error?: string; total?: number };

/**
 * Turns any API answer into either `data` or a thrown `PortalApiError`.
 *
 * The message extraction is deliberately broad because NestJS and this project's
 * own handlers disagree about where the human-readable text goes: a
 * `HttpException` with an object body puts it in `message`, a plain one puts it
 * in `message` too, and this project's field endpoints use `error`.
 */
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
    throw new PortalApiError(
      `API-yə qoşulmaq mümkün olmadı (${API_BASE_URL}). Səbəb: ${reason}`,
      null,
      'API_UNREACHABLE'
    );
  }

  const text = await response.text();
  let payload: Envelope<T> & { message?: string | string[] } = {};

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new PortalApiError(
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
    throw new PortalApiError(
      message || `API xətası (HTTP ${response.status})`,
      response.status,
      (payload as any)?.error ?? null
    );
  }

  return payload.data as T;
}

class PortalApiClient {
  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /** For startup logs. Never includes the token. */
  describeTarget(): string {
    return API_BASE_URL;
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

  /** Resolves a store code typed by a merchandiser. Null when no such store. */
  async validateAndGetStore(storeCode: string): Promise<StoreRecord | null> {
    const code = storeCode.trim().toUpperCase();
    if (!code) return null;
    const store = await request<StoreRecord | null>(
      `/api/portal/field/store?code=${encodeURIComponent(code)}`
    );
    // A deactivated store must not accept audits even though it still resolves.
    if (!store || store.is_active === false) return null;
    return store;
  }

  /**
   * The work a merchandiser can act on at a store.
   *
   * The API already excludes drafts and finished tasks, so whatever comes back
   * is what the chat should show.
   */
  async getTasksForStore(storeId: string): Promise<TaskRecord[]> {
    const tasks = await request<TaskRecord[]>(
      `/api/portal/field/tasks?storeId=${encodeURIComponent(storeId)}`
    );
    return tasks ?? [];
  }

  /**
   * One task by its store-task id.
   *
   * The id here is a `store_tasks` row, not a template — that is what the
   * submission endpoint expects, and the API returns it that way so the two
   * cannot drift apart.
   */
  async getTaskById(taskId: string): Promise<TaskRecord | null> {
    return await request<TaskRecord | null>(
      `/api/portal/field/tasks/${encodeURIComponent(taskId)}`
    );
  }

  async getSubmissionsByChatId(chatId: number | string, limit = 5): Promise<SubmissionRecord[]> {
    const submissions = await request<SubmissionRecord[]>(
      `/api/portal/field/submissions?chatId=${encodeURIComponent(String(chatId))}&limit=${limit}`
    );
    return submissions ?? [];
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Links a chat to a person, and claims the store's open work.
   *
   * `storeId` is what makes submission possible: the API refuses an audit from
   * a merchandiser who is not the task's assignee, and a chat has no supervisor
   * to do the assigning. Passing the store here records the claim. See
   * `FieldService.bind` for the full reasoning.
   */
  async bindTelegramUser(params: {
    telegramChatId: number | string;
    fullName: string;
    username?: string;
    storeId?: string;
  }): Promise<{ id: string; role: string; claimedTaskIds: string[] }> {
    const result = await request<{ id: string; role: string; claimedTaskIds?: string[] }>(
      '/api/portal/field/bind',
      {
        method: 'POST',
        body: JSON.stringify({
          chatId: params.telegramChatId,
          fullName: params.fullName,
          storeId: params.storeId,
        }),
      }
    );

    if (!result?.id) {
      throw new PortalApiError('İstifadəçi qeydiyyatı alınmadı', 500, 'BIND_FAILED');
    }
    return { id: result.id, role: result.role, claimedTaskIds: result.claimedTaskIds ?? [] };
  }

  /**
   * Prepares a shelf photo for submission.
   *
   * Returns a `data:` URL rather than uploading anywhere, because there is no
   * object store yet — see the file header. The `fileName` the caller would
   * have used as a storage key is not discarded: the handler records it in the
   * submission metadata as `storage_path`, so the photo can be moved into real
   * storage later without guessing where it came from.
   */
  async uploadShelfPhoto(params: {
    fileBuffer: Buffer;
    fileName: string;
    contentType?: string;
  }): Promise<string> {
    const { fileBuffer, contentType = 'image/jpeg' } = params;

    const dataUrl = `data:${contentType};base64,${fileBuffer.toString('base64')}`;

    if (dataUrl.length > MAX_PHOTO_BYTES) {
      throw new PortalApiError(
        `Şəkil çox böyükdür (${Math.round(dataUrl.length / 1024)} KB). ` +
          `Maksimum ${Math.round(MAX_PHOTO_BYTES / 1024)} KB qəbul edilir. ` +
          `Zəhmət olmasa daha aşağı keyfiyyətdə yenidən çəkin.`,
        413,
        'PHOTO_TOO_LARGE'
      );
    }

    return dataUrl;
  }

  /**
   * Files a shelf audit.
   *
   * LOCATION IS DECLARED UNVERIFIED, NOT FAKED
   * ------------------------------------------
   * Telegram does not attach coordinates to a photo. The API's geofence check
   * needs a pair of coordinates, and the tempting shortcut — sending the
   * store's own coordinates — would make every chat submission pass a control
   * that exists to catch submissions made from somewhere else.
   *
   * So the honest flag goes with the request: the API then runs the pipeline,
   * records a `GEOFENCE_NOT_VERIFIED` audit event, and a supervisor can see that
   * this evidence is weaker than one captured by the mobile client with a real
   * fix.
   *
   * When the bot starts asking for a location before the photo, passing
   * `latitude`/`longitude` here is the only change needed.
   */
  async createSubmission(params: {
    storeTaskId: string;
    chatId: number | string;
    photoUrl: string;
    photoType?: 'before' | 'after' | 'standard';
    latitude?: number;
    longitude?: number;
    metadata?: Record<string, unknown>;
  }): Promise<SubmissionRecord> {
    const hasFix = typeof params.latitude === 'number' && typeof params.longitude === 'number';

    const result = await request<SubmissionRecord>('/api/portal/field/submissions', {
      method: 'POST',
      body: JSON.stringify({
        chatId: params.chatId,
        storeTaskId: params.storeTaskId,
        photoUrl: params.photoUrl,
        photoType: params.photoType ?? 'standard',
        latitude: params.latitude,
        longitude: params.longitude,
        locationUnverified: !hasFix,
        metadata: params.metadata ?? {},
      }),
    });

    if (!result?.id) {
      throw new PortalApiError('Audit qeydə alınmadı', 500, 'SUBMISSION_FAILED');
    }

    // `PanelSubmission` is a superset of `SubmissionRecord`; the bot only reads
    // the fields the two share, so no adapter is needed and none should be
    // added without a reason.
    return result;
  }
}

export const portalApi = new PortalApiClient();
