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
 * Into an S3-compatible bucket (Cloudflare R2 in production), by the shortest
 * path the deployment allows:
 *
 *   1. Preferred — a PRESIGNED DIRECT UPLOAD. `uploadShelfPhoto` asks the API
 *      for a short-lived signed URL (`POST photos/presign`), PUTs the bytes
 *      STRAIGHT to the bucket, and returns only the resulting public URL. The
 *      image never travels through the API, so it is not bounded by the API's
 *      JSON body limit and no megabytes cross the API twice.
 *
 *   2. Fallback — an inline `data:` URL, exactly the pre-presigned behaviour.
 *      Used when the API has no bucket configured (it answers
 *      `STORAGE_NOT_CONFIGURED`), or when the direct PUT fails for a reason the
 *      merchandiser cannot act on. The API then offloads that data URL to the
 *      bucket on its own side, or keeps it inline where no bucket exists. This
 *      path still carries the base64 in the request body, so the `MAX_PHOTO_BYTES`
 *      cap below stays load-bearing for it.
 *
 * The fallback is why an audit is never lost to a storage hiccup: the worst case
 * is one photo taking the slower, size-capped inline route instead of failing.
 */

import dotenv from 'dotenv';
import type { FieldFlowPayload } from '@oneteam/types';
import { isServiceCredential, signServiceCredential } from '@oneteam/types';
import { StoreRecord, TaskRecord, SubmissionRecord, PendingNotification } from '../bot/types';

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
 * SIGNED AND EXPIRING WHEN POSSIBLE
 * ---------------------------------
 * When `ONETEAM_SERVICE_SIGNING_SECRET` is configured (shared with the API), the
 * bot mints a *signed, short-lived* credential for every request via
 * `signServiceCredential`. A leaked request header is then replayable only until
 * it expires — minutes — instead of forever, which is what the unsigned form
 * allowed.
 *
 * When no secret is set the bot sends the static `ONETEAM_API_TOKEN` (legacy),
 * so upgrading changes nothing until the operator opts in.
 *
 * The hardcoded `usr-admin-001` default has been removed: shipping an implicit
 * admin credential in the image is exactly the risk this is closing. A build
 * with nothing configured refuses to start in production and only falls back to
 * the dev admin locally, loudly.
 */
const SERVICE_SIGNING_SECRET = (process.env.ONETEAM_SERVICE_SIGNING_SECRET || '').trim();
const STATIC_API_TOKEN = (process.env.ONETEAM_API_TOKEN || '').trim();

/** The user the bot acts as for its service calls — never assumed to be admin. */
function resolveServiceUserId(): string | null {
  const explicit = (process.env.ONETEAM_SERVICE_USER_ID || '').trim();
  if (explicit) return explicit;
  if (isServiceCredential(STATIC_API_TOKEN)) {
    return STATIC_API_TOKEN.slice('oneteam-user:'.length).trim() || null;
  }
  return null;
}

const SERVICE_USER_ID = resolveServiceUserId();
const CAN_SIGN = Boolean(SERVICE_SIGNING_SECRET && SERVICE_USER_ID);
const CAN_AUTHENTICATE = CAN_SIGN || Boolean(STATIC_API_TOKEN);
const DEV_FALLBACK_TOKEN = 'oneteam-user:usr-admin-001';

if (!CAN_AUTHENTICATE) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'oneTeam bot: set ONETEAM_API_TOKEN, or ONETEAM_SERVICE_SIGNING_SECRET + ' +
        'ONETEAM_SERVICE_USER_ID. Refusing to start with an implicit admin credential.',
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    '⚠️  oneTeam bot: no credential configured; using the dev admin fallback. ' +
      'Never deploy this — set ONETEAM_SERVICE_SIGNING_SECRET + ONETEAM_SERVICE_USER_ID.',
  );
}

/** The bearer for a single request: signed + expiring when possible, else static. */
function authToken(): string {
  if (CAN_SIGN) return signServiceCredential(SERVICE_USER_ID as string, SERVICE_SIGNING_SECRET);
  if (STATIC_API_TOKEN) return STATIC_API_TOKEN;
  return DEV_FALLBACK_TOKEN;
}

/** Long enough for a cold container, short enough that a chat is never left hanging. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The guided flow's leash, and why it is much shorter than the one above.
 *
 * The flow is read before *every* update the bot handles and written after it,
 * so this timeout sits on the critical path of every single message a field
 * worker sends — including messages that have nothing to do with the flow. At
 * twenty seconds, an API that is up but slow would make the bot look dead to
 * someone standing in a shop with a phone in their hand.
 *
 * Five seconds is far longer than a round trip to the API over the private
 * network takes, so a request that reaches this has already failed in a way that
 * is worth telling the person about rather than making them wait.
 */
const FLOW_TIMEOUT_MS = 5_000;

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

type Envelope<T> = {
  success?: boolean;
  data?: T;
  message?: string;
  error?: string;
  total?: number;
};

/**
 * Turns any API answer into either `data` or a thrown `PortalApiError`.
 *
 * The message extraction is deliberately broad because NestJS and this project's
 * own handlers disagree about where the human-readable text goes: a
 * `HttpException` with an object body puts it in `message`, a plain one puts it
 * in `message` too, and this project's field endpoints use `error`.
 *
 * `timeoutMs` is a parameter rather than a constant because the calls this
 * client makes are not alike. A photo upload carries up to 1.5 MB and deserves
 * the full twenty seconds; the guided flow's state is a few hundred bytes and is
 * read on *every* update, including ones that have nothing to do with the flow.
 * Giving that call twenty seconds would mean a chat hanging for twenty seconds
 * on "salam" whenever the API is unwell — see `FLOW_TIMEOUT_MS`.
 */
async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const url = `${API_BASE_URL}${path}`;
  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken()}`,
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new PortalApiError(
      `API-yə qoşulmaq mümkün olmadı (${API_BASE_URL}). Səbəb: ${reason}`,
      null,
      'API_UNREACHABLE',
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
          'BAD_RESPONSE',
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
      (payload as any)?.error ?? null,
    );
  }

  return payload.data as T;
}

/** What `POST photos/presign` hands back — a signed URL and the address to submit. */
interface PresignedUpload {
  /** The short-lived signed URL to PUT the bytes to, directly on the bucket. */
  uploadUrl: string;
  /** The address the object will be readable at — this is what becomes `photoUrl`. */
  publicUrl: string;
  key: string;
  expiresAt: string;
  /** The headers the URL was signed to expect — just `Content-Type` today. */
  requiredHeaders: Record<string, string>;
}

/** Asks the API for a short-lived signed URL to upload one photo straight to the bucket. */
async function requestPresignedUpload(params: {
  contentType: string;
  scope?: string;
}): Promise<PresignedUpload> {
  return request<PresignedUpload>('/api/portal/field/photos/presign', {
    method: 'POST',
    body: JSON.stringify({ contentType: params.contentType, scope: params.scope }),
  });
}

/** True when the API answered that it has no object store configured (dev / inline). */
function isStorageNotConfigured(error: unknown): boolean {
  return error instanceof PortalApiError && error.code === 'STORAGE_NOT_CONFIGURED';
}

/**
 * PUTs the photo bytes straight to the presigned URL.
 *
 * A raw `fetch`, deliberately NOT the `request()` helper above: the URL is the
 * bucket's rather than the API's, the signature already rides in the query
 * string so there is no `Authorization` header, and the body is binary rather
 * than JSON. The only header the bucket expects is the `Content-Type` the URL
 * was signed to allow, which the API returns as `requiredHeaders`.
 */
async function putToPresignedUrl(
  presigned: PresignedUpload,
  fileBuffer: Buffer,
  contentType: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(presigned.uploadUrl, {
      method: 'PUT',
      headers: presigned.requiredHeaders ?? { 'Content-Type': contentType },
      body: new Uint8Array(fileBuffer),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new PortalApiError(
      `Şəkli anbara birbaşa yükləmək mümkün olmadı. Səbəb: ${reason}`,
      null,
      'DIRECT_UPLOAD_UNREACHABLE',
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new PortalApiError(
      `Şəkil anbara yüklənmədi (HTTP ${response.status})` +
        (detail ? `: ${detail.slice(0, 300)}` : ''),
      response.status,
      'DIRECT_UPLOAD_FAILED',
    );
  }
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
      // `/api/portal/field/whoami`, not `/api/portal/stores`. The stores route is
      // the supervisor API: it used to answer a bot with the whole chain's store
      // list, which is more than a liveness check should ever read. Now that the
      // supervisor routes require a panel key, it would also be the wrong
      // question to ask.
      await request<unknown>('/api/portal/field/whoami');
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
      `/api/portal/field/store?code=${encodeURIComponent(code)}`,
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
      `/api/portal/field/tasks?storeId=${encodeURIComponent(storeId)}`,
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
    return request<TaskRecord | null>(`/api/portal/field/tasks/${encodeURIComponent(taskId)}`);
  }

  async getSubmissionsByChatId(chatId: number | string, limit = 5): Promise<SubmissionRecord[]> {
    const submissions = await request<SubmissionRecord[]>(
      `/api/portal/field/submissions?chatId=${encodeURIComponent(String(chatId))}&limit=${limit}`,
    );
    return submissions ?? [];
  }

  /**
   * Tells the API that the field worker has taken the task on.
   *
   * Without this the audit is unreviewable. The lifecycle only allows a review
   * from SUBMITTED, and the photo submission only advances a task that is
   * already ACKNOWLEDGED — so a task left at PUBLISHED would collect evidence
   * that no supervisor could ever approve.
   *
   * In the notification flow this happens automatically: the push marks the task
   * DELIVERED and the button tap marks it ACKNOWLEDGED. The bot polls instead of
   * receiving webhooks, so the chat calls this when the merchandiser opens the
   * task, which is the same act.
   *
   * Failure is not fatal to the flow — the photo can still be filed — so callers
   * should log it rather than stop.
   */
  async acknowledgeTask(
    taskId: string,
    chatId: number | string,
  ): Promise<{ taskId: string; currentState: string; advanced: boolean }> {
    return request<{ taskId: string; currentState: string; advanced: boolean }>(
      `/api/portal/field/tasks/${encodeURIComponent(taskId)}/acknowledge`,
      { method: 'POST', body: JSON.stringify({ chatId }) },
    );
  }

  /**
   * Claims a single store task for the chat before it acts on it.
   *
   * `bindTelegramUser` only claims a store's *unassigned* open work; this takes
   * on the specific task being opened even when the panel pre-assigned it to
   * someone else, because whoever holds the store code is the person in the
   * store. The API refuses to take a task already in progress elsewhere and
   * audits every takeover — see `FieldService.claimStoreTask`. Non-fatal: a
   * failure is logged and the open flow continues.
   */
  async claimTask(
    taskId: string,
    chatId: number | string,
    storeId: string,
  ): Promise<{
    taskId: string;
    assignedUserId: string | null;
    claimed: boolean;
    previousAssignee?: string | null;
    reason?: string;
  }> {
    return request(`/api/portal/field/tasks/${encodeURIComponent(taskId)}/claim`, {
      method: 'POST',
      body: JSON.stringify({ chatId, storeId }),
    });
  }

  // -------------------------------------------------------------------------
  // The guided flow's position
  //
  // WHY THE BOT DOES NOT KEEP THIS IN ITS OWN MEMORY
  // ------------------------------------------------
  // grammy's default session store is a `Map` inside the bot process, and the
  // bot process is replaced on every deploy. A merchandiser who had answered two
  // of three questions would come back to a bot asking for their store code
  // again — no error, no explanation, and their answers apparently gone even
  // though nothing had actually been at risk.
  //
  // So the position lives in the database and the bot reaches it here. The
  // mechanics are in `src/bot/sessionStorage.ts`; this is only the wire.
  // -------------------------------------------------------------------------

  /**
   * Where this chat is in the guided flow, or null when there is nothing to
   * resume.
   *
   * Null and "could not ask" are different answers and are kept different: an
   * unreachable API throws. See `ApiSessionStorage.read` for why that distinction
   * matters more than it looks — the alternative is a bot that silently starts
   * the flow over.
   */
  async getFlow(chatId: number | string): Promise<FieldFlowPayload | null> {
    return request<FieldFlowPayload | null>(
      `/api/portal/field/flow?chatId=${encodeURIComponent(String(chatId))}`,
      {},
      FLOW_TIMEOUT_MS,
    );
  }

  /**
   * Writes the whole position.
   *
   * The API validates it before storing, so a step this system does not know
   * about is refused rather than saved and then found unreadable later.
   *
   * The API derives the person from the chat instead of taking one from here.
   * The bot is not the authority on who a chat belongs to, and letting it assert
   * one would be a way for a bug in the bot to write somebody else's flow.
   */
  async saveFlow(
    chatId: number | string,
    flow: FieldFlowPayload,
  ): Promise<FieldFlowPayload | null> {
    return request<FieldFlowPayload | null>(
      '/api/portal/field/flow',
      { method: 'PUT', body: JSON.stringify({ chatId, ...flow }) },
      FLOW_TIMEOUT_MS,
    );
  }

  /**
   * Forgets a chat's position.
   *
   * Called when the audit is filed, when the person starts over, and — through
   * `ApiSessionStorage.write` — whenever the session has become empty, so a chat
   * that only ever said "salam" does not leave a row behind.
   *
   * `false` is a normal answer, not a failure: it means there was nothing to
   * forget, which is what the second call in a row gets.
   */
  async clearFlow(chatId: number | string): Promise<boolean> {
    const result = await request<{ cleared: boolean }>(
      `/api/portal/field/flow?chatId=${encodeURIComponent(String(chatId))}`,
      { method: 'DELETE' },
      FLOW_TIMEOUT_MS,
    );
    return Boolean(result?.cleared);
  }

  // -------------------------------------------------------------------------
  // The outbox
  //
  // WHY THE BOT POLLS THE API FOR THESE INSTEAD OF RECEIVING A PUSH
  // ---------------------------------------------------------------
  // The API is the only process that can write to the database, and the bot is
  // the only process holding the bot token, so a notification has to cross
  // between them. The API records the intent; the bot asks for what is waiting.
  //
  // A webhook from the API to the bot was the alternative and is worse: it needs
  // a second inbound surface with its own authentication, and it fails silently
  // whenever the bot is restarting. Polling a table that survives both processes
  // cannot lose a message.
  //
  // The GET is a *claim*, not a read: the API leases the rows it returns, so two
  // bot instances overlapping on a deploy cannot both send the same message. A
  // message this client takes and never reports back is not lost — the lease
  // expires and the next poll returns it again.
  // -------------------------------------------------------------------------

  /**
   * Leases the messages waiting to be sent.
   *
   * `chatId` is normally omitted: the bot drains every chat, because it has no
   * way to know which chats have anything waiting. It is accepted so a test can
   * take exactly one chat's queue.
   */
  async claimNotifications(
    options: { chatId?: number | string; limit?: number; claimedBy?: string } = {},
  ): Promise<PendingNotification[]> {
    const query = new URLSearchParams();
    if (options.chatId !== undefined) query.set('chatId', String(options.chatId));
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.claimedBy) query.set('claimedBy', options.claimedBy);

    const suffix = query.toString() ? `?${query}` : '';
    const rows = await request<PendingNotification[]>(
      `/api/portal/field/notifications${suffix}`,
      {},
      FLOW_TIMEOUT_MS,
    );
    return rows ?? [];
  }

  /** Records that Telegram accepted the message. */
  async markNotificationDelivered(id: string): Promise<boolean> {
    const result = await request<{ delivered: boolean }>(
      `/api/portal/field/notifications/${encodeURIComponent(id)}/delivered`,
      { method: 'POST' },
      FLOW_TIMEOUT_MS,
    );
    return Boolean(result?.delivered);
  }

  /**
   * Records that Telegram refused the message for a reason a retry cannot fix.
   *
   * Only terminal refusals belong here — a blocked bot, a deleted chat. A
   * network failure must NOT be reported: leaving it alone lets the lease expire
   * so the message is tried again, which is the difference between a delayed
   * notification and a lost one.
   */
  async markNotificationFailed(id: string, failure: string): Promise<boolean> {
    const result = await request<{ failed: boolean }>(
      `/api/portal/field/notifications/${encodeURIComponent(id)}/failed`,
      { method: 'POST', body: JSON.stringify({ failure }) },
      FLOW_TIMEOUT_MS,
    );
    return Boolean(result?.failed);
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
      },
    );

    if (!result?.id) {
      throw new PortalApiError('İstifadəçi qeydiyyatı alınmadı', 500, 'BIND_FAILED');
    }
    return { id: result.id, role: result.role, claimedTaskIds: result.claimedTaskIds ?? [] };
  }

  /**
   * Gets a shelf photo into storage and returns the URL to submit.
   *
   * Tries the presigned direct upload first: the API mints a short-lived signed
   * URL, the bot PUTs the bytes STRAIGHT to the bucket, and the returned public
   * URL is what gets submitted — the image never passes through the API.
   *
   * Falls back to an inline `data:` URL when the API has no bucket configured,
   * or when the direct PUT fails for a reason the merchandiser cannot act on.
   * That path is the pre-presigned behaviour and is bounded by `MAX_PHOTO_BYTES`
   * because the base64 still travels in the submission body — see the file
   * header for the whole picture.
   *
   * The `fileName` the caller passes is the intended storage path; the server
   * mints the final key itself, but its directory is honoured as the `scope` so
   * a store's evidence stays grouped in the bucket.
   */
  async uploadShelfPhoto(params: {
    fileBuffer: Buffer;
    fileName: string;
    contentType?: string;
  }): Promise<string> {
    const { fileBuffer, fileName, contentType = 'image/jpeg' } = params;

    const scope = fileName?.includes('/') ? fileName.replace(/\/[^/]*$/, '') : undefined;

    try {
      const presigned = await requestPresignedUpload({ contentType, scope });
      await putToPresignedUrl(presigned, fileBuffer, contentType);
      return presigned.publicUrl;
    } catch (error) {
      if (!isStorageNotConfigured(error)) {
        // Not "no bucket" — a real failure of the direct path (bucket
        // unreachable, signature refused). Fall through to inline rather than
        // lose the audit: the API still offloads a data URL to the bucket on
        // its side. Logged so a persistently broken direct path is visible
        // instead of silently costing the body limit on every submission.
        // eslint-disable-next-line no-console
        console.warn(
          `[oneTeam Bot] Presigned upload failed, falling back to inline: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // STORAGE_NOT_CONFIGURED is expected on a deployment without a bucket;
      // inline is the correct answer there and needs no warning.
    }

    const dataUrl = `data:${contentType};base64,${fileBuffer.toString('base64')}`;

    if (dataUrl.length > MAX_PHOTO_BYTES) {
      throw new PortalApiError(
        `Şəkil çox böyükdür (${Math.round(dataUrl.length / 1024)} KB). ` +
          `Maksimum ${Math.round(MAX_PHOTO_BYTES / 1024)} KB qəbul edilir. ` +
          `Zəhmət olmasa daha aşağı keyfiyyətdə yenidən çəkin.`,
        413,
        'PHOTO_TOO_LARGE',
      );
    }

    return dataUrl;
  }

  /**
   * Files a shelf audit.
   *
   * LOCATION IS EITHER REAL OR DECLARED UNVERIFIED — NEVER FAKED
   * -----------------------------------------------------------
   * The guided flow in `handlers/taskFlow.ts` asks for the merchandiser's
   * location before the photo, so the common case now arrives with a genuine
   * fix and the API's geofence check actually runs.
   *
   * When the merchandiser skips that prompt there are no coordinates, and the
   * tempting shortcut — sending the store's own coordinates — would make every
   * chat submission pass a control that exists to catch submissions made from
   * somewhere else. So the honest flag goes with the request instead: the API
   * runs the pipeline, records a `GEOFENCE_NOT_VERIFIED` audit event, and a
   * supervisor can see that this evidence is weaker than one captured with a
   * real fix.
   *
   * The same applies to `checklistAnswers`: they are sent when the flow
   * collected them, and omitted when it did not, which the API records as
   * `CHECKLIST_NOT_COLLECTED`.
   */
  async createSubmission(params: {
    storeTaskId: string;
    chatId: number | string;
    photoUrl: string;
    photoType?: 'before' | 'after' | 'standard';
    latitude?: number;
    longitude?: number;
    checklistAnswers?: Array<{ questionId: string; value: boolean | number | string }>;
    metadata?: Record<string, unknown>;
    /**
     * The vision engine's read of this photo, when one ran (see
     * `handlers/submission.ts`). Sent so the API persists it on the evidence and
     * can auto-approve a high-confidence pass without a human. Omitted entirely
     * when vision is off, which is exactly the pre-vision behaviour.
     *
     * These are trusted because the sender is the bot's service credential, not
     * a chat: a merchandiser cannot forge them — they can only send a photo.
     */
    ai?: {
      score: number;
      summary: string;
      detections?: unknown[];
      confidence: number;
      needsHumanReview: boolean;
      engine?: string;
      model?: string;
    };
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
        checklistAnswers: params.checklistAnswers ?? [],
        metadata: params.metadata ?? {},
        // Flattened rather than nested so the API's `body: any` handler can read
        // each field without reaching into an object that may be absent.
        ...(params.ai
          ? {
              aiScore: params.ai.score,
              aiSummary: params.ai.summary,
              aiDetections: params.ai.detections ?? [],
              aiConfidence: params.ai.confidence,
              aiNeedsHumanReview: params.ai.needsHumanReview,
              aiEngine: params.ai.engine,
              aiModel: params.ai.model,
            }
          : {}),
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
