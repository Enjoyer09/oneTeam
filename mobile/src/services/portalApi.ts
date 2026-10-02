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
 * HOW THE APP IDENTIFIES ITSELF, AND WHAT IT HOLDS
 * ------------------------------------------------
 * The bot identifies the acting person by the Telegram chat an update came from.
 * A device has no chat, so it identifies them by the installation it was enrolled
 * on: an identity minted once and kept in the keychain, plus a credential issued
 * to that installation. See `credentialStore.ts` for why both are needed and why
 * the identity must never change.
 *
 * The credential is a device token, obtained once from
 * `POST /api/portal/field/enroll` by presenting the store's code, and it
 * identifies exactly one user. It replaced a shared service credential that this
 * bundle used to carry — and which defaulted to `oneteam-user:usr-admin-001`, so
 * an unconfigured build acted as an administrator. Anyone who extracted that
 * string from the downloaded bundle had access to every store, every task and
 * every audit. A device token is worth one installation, and the API refuses a
 * device credential that tries to name a different one.
 *
 * The credential is kept in the keychain by `credentialStore.ts`, and the app
 * calls `restoreCredential()` once at startup to read it back. The Node harness
 * has no keychain, so there the store falls back to memory and `enroll` runs
 * again on each start; nothing about the API side changes either way.
 *
 * WHERE THE PHOTOS GO
 * -------------------
 * When the API is configured with a bucket, a real capture is PUT straight to
 * that bucket through a short-lived presigned URL the API mints — the bytes
 * never travel through the API body, and this client submits the returned
 * `publicUrl`. See `uploadPhoto` below and the matching code in the Telegram
 * bot's `src/services/portalApi.ts`; the two clients mirror each other on
 * purpose. Two things send a capture back to the inline `data:` URL instead:
 * an API that reports no bucket (`STORAGE_NOT_CONFIGURED` — the correct answer
 * in inline mode), and a direct PUT that fails (the API still offloads the
 * data URL on its side, so the audit is never lost). The placeholder marker
 * always goes inline — it is not worth a bucket object.
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
import { credentialStore } from './credentialStore';
import { isLowConfidenceFix } from '../utils/geofence';

/**
 * The harness-only variable names, read through an alias.
 *
 * Reading `process.env` through a local alias is DELIBERATE here and is the
 * opposite of what the block below does. Expo/Metro substitutes only
 * `process.env.EXPO_PUBLIC_*`, written as a direct member expression; everything
 * else — including every name reached through this alias — survives into the
 * bundle as a real lookup and evaluates to `undefined` on the device. That is
 * exactly what these names need, because they are the Node harness's way of
 * naming itself and must NOT be settable in a shipping build.
 */
const env: Record<string, string | undefined> =
  typeof process !== 'undefined' && process.env ? process.env : {};

/**
 * The build-time variables Expo actually substitutes.
 *
 * WHY THIS ONE IS WRITTEN OUT IN FULL
 * -----------------------------------
 * `EXPO_PUBLIC_ONETEAM_API_URL` appears below as a direct member expression
 * (`process.env.EXPO_PUBLIC_ONETEAM_API_URL`), not through the alias above and
 * not through a computed key. Metro matches the literal source text, so:
 *
 *   - `process.env[name]` is not substituted — the bundler cannot see through a
 *     variable, the expression survives, and it is `undefined` on the device;
 *   - the `const env = process.env` alias makes EVERY name look non-public, so
 *     the address silently fell back to `http://localhost:3001` in a real build.
 *     Nothing failed. The app simply pointed at a machine that is not there.
 *
 * Both were measured in plan item 3.1 and this is the fix. The shape is
 * fragile — a tidy-looking refactor into a loop would silently undo it — so
 * `scripts/dev/verify-mobile-config.mjs` asserts that the direct member
 * expression is still present.
 *
 * WHY ONLY THE ADDRESS HAS A PUBLIC NAME
 * --------------------------------------
 * `EXPO_PUBLIC_*` values are compiled into the downloadable bundle and can be
 * extracted from it. The address is not a secret — it is in every request the
 * app makes. The other three names are:
 *
 *   - `ONETEAM_DEVICE_TOKEN` and `ONETEAM_DEVICE_ID` are read below through the
 *     alias and are the harness's. A device credential that ships inside an IPA
 *     is worth one installation and extractable; there is no reason to accept
 *     that, and `credentialStore` exists to keep it in the keychain instead.
 *   - `ONETEAM_ENROLLMENT_SECRET` is the deployment's second factor. The same
 *     argument, more so: `credentialStore.enrollmentSecret()` keeps it in the
 *     keychain precisely so that it is not a string compiled into the binary.
 *
 * The config script fails if any of the three ever gains an `EXPO_PUBLIC_` name,
 * because that would be a quiet way to publish a credential.
 */
const PUBLIC_API_URL =
  typeof process !== 'undefined' && process.env
    ? process.env.EXPO_PUBLIC_ONETEAM_API_URL
    : undefined;

/**
 * Where the API is, resolved in order of who is allowed to say.
 *
 * The public build-time name wins: it is the only one that can exist in a real
 * build, and an operator setting it on a build machine means it. The two harness
 * names follow, for the same reason they exist at all — `ONETEAM_API_URL` is
 * what the bot and the test runners already use, so one deployment describes
 * both channels with one variable. The literal is last and is not a default
 * anybody should ship: it is what a developer's machine happens to have, and it
 * is reported as the target on the app's own status screen.
 */
const API_BASE_URL = (
  PUBLIC_API_URL ||
  env.ONETEAM_API_URL ||
  env.API_BASE_URL ||
  'http://localhost:3001'
).replace(/\/+$/, '');

/**
 * The credential this installation holds, once `restoreCredential()` has run.
 *
 * Deliberately NOT defaulted from a literal. The value it replaced fell back to
 * `oneteam-user:usr-admin-001`, which meant a build with no configuration
 * authenticated as an administrator — the worst possible default for a string
 * that ships inside a downloadable bundle. There is now no way to reach the API
 * without a token that was actually issued to this installation, and
 * `request()` refuses rather than trying.
 *
 * The environment variable is still read, and it is the LAST resort rather than
 * the first: `restoreCredential()` prefers what the keychain holds, and this is
 * what remains for the Node harness, which has no keychain. A shipping build
 * never sets it.
 */
let deviceToken: string | null = (env.ONETEAM_DEVICE_TOKEN || '').trim() || null;

/**
 * This installation's identity, once `restoreCredential()` has read it.
 *
 * Held here as well as in `credentialStore` because `deviceId()` is synchronous
 * and is called from nine places, several of them inside template strings and
 * query parameters. Making all of those await would be a large change for no
 * benefit: the identity is fixed for the life of the process, so it is read once
 * and then it is a plain string.
 */
let cachedDeviceId: string | null = null;

/** Whether this installation can talk to the API yet. */
export function hasDeviceToken(): boolean {
  return deviceToken !== null;
}

/** The current token, for a caller that needs to inspect it. */
export function currentDeviceToken(): string | null {
  return deviceToken;
}

/**
 * Reads the installation identity and credential out of storage.
 *
 * MUST be called once at startup, before any request. Before it runs,
 * `deviceId()` throws and no token is attached, so the failure is immediate and
 * legible rather than a request that silently goes out unidentified.
 *
 * It also mints the identity if this is the first launch. That write is the
 * reason this is async and the reason it is called before the first render:
 * every later call to `deviceId()` is then a cache hit.
 *
 * The value it returns is the identity that will actually be used, which is not
 * always the one it cached: `ONETEAM_DEVICE_ID` is an overlay applied on top
 * (see `currentDeviceId`). The installation's own identity is still read and
 * minted underneath it, so that removing the variable does not leave the process
 * with nothing.
 */
export async function restoreCredential(): Promise<{ deviceId: string; hasToken: boolean }> {
  cachedDeviceId = await credentialStore.deviceId();

  const stored = await credentialStore.deviceToken();
  if (stored) {
    deviceToken = stored;
  }

  return { deviceId: currentDeviceId() ?? cachedDeviceId, hasToken: deviceToken !== null };
}

/**
 * Drops the credential, from memory and from storage.
 *
 * For a 401 — the API refuses a credential that is unknown, revoked, or whose
 * user was deleted, and all three mean the same thing to this client: enrol
 * again. The identity is NOT dropped, so the next enrolment comes back as the
 * same device and keeps its history; see `CredentialStore.clearDeviceToken`.
 *
 * Revoking on the server is a separate act, and — correcting an earlier note
 * here — it IS possible from the panel now: `POST /api/panel/.../devices/:id/
 * revoke`, see `keychain.ts`. There was an interaction worth spelling out: this
 * client answers a 401 by enrolling again, and enrolment is gated only by the
 * store code, so a revoked device that still knew the code used to re-enrol
 * straight back to a working token. Making revocation survive re-enrolment was a
 * server policy decision, and it is now made: revoke also writes a `device_blocks`
 * bar on the `deviceId`, enrolment refuses a barred device with `403
 * DEVICE_BLOCKED`, and only an admin lifts it (`.../devices/:id/unblock`). So the
 * loop is closed on the server, exactly where it belongs — this client still just
 * enrols again, and the barred device simply gets a 403 instead of a token.
 */
export async function forgetCredential(): Promise<void> {
  deviceToken = null;
  await credentialStore.clearDeviceToken();
}

export interface EnrollmentResult {
  userId: string;
  fullName: string;
  role: string;
  store: {
    id: string;
    storeCode: string;
    name: string;
    latitude: number | null;
    longitude: number | null;
  };
  claimedTaskIds: string[];
}

/**
 * What `enroll` answers: the API's payload, plus whether this device kept the
 * credential it was just given.
 *
 * `credentialPersisted` is not decoration. The API revokes this installation's
 * previous live token as it issues the new one, so a device that fails to store
 * the new value is holding a credential that has already stopped working — and
 * it would only find out on its next request, after the worker had walked away
 * believing the sign-in worked. Reporting it here lets the caller say so while
 * the screen is still up.
 */
export type EnrollmentOutcome = EnrollmentResult & { credentialPersisted: boolean };

/**
 * Registers this installation and stores the credential it is given.
 *
 * The store code is the claim, exactly as it is in the Telegram flow: whoever
 * knows it is treated as standing in that store. That is a deliberate reuse
 * rather than a second, weaker rule for the app.
 *
 * This is the only call that does not go through `request()`, because it is the
 * call that obtains the credential `request()` needs. It is also the only
 * endpoint in the field API that is not behind the auth guard — see the header
 * of the API's `enrollment.controller.ts` for why that is unavoidable and what
 * narrows it.
 */
export async function enroll(params: {
  storeCode: string;
  fullName: string;
  enrollmentSecret?: string;
}): Promise<EnrollmentOutcome> {
  // The order is deliberate. An explicit argument wins, then what an operator
  // entered on this device, then the environment — which is the harness path and
  // the weakest of the three, because it is the copy that ships in the bundle.
  const secret =
    params.enrollmentSecret ??
    (await credentialStore.enrollmentSecret()) ??
    env.ONETEAM_ENROLLMENT_SECRET ??
    undefined;

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/portal/field/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeCode: params.storeCode,
        fullName: params.fullName,
        deviceId: deviceId(),
        // See the resolution order above. Without a fallback at all, a
        // deployment that turned the second factor on would simply see enrolment
        // stop working — the worst kind of security feature.
        enrollmentSecret: secret,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new MobileApiError(
      `API-yə qoşulmaq mümkün olmadı (${API_BASE_URL}). Səbəb: ${reason}`,
      null,
      'API_UNREACHABLE',
    );
  }

  const text = await response.text();
  let payload: any = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {};
    }
  }

  if (!response.ok || !payload?.data?.token) {
    const detail =
      payload?.message || payload?.error || `Qeydiyyat alınmadı (HTTP ${response.status})`;
    throw new MobileApiError(
      Array.isArray(detail) ? detail.join(', ') : String(detail),
      response.status,
      payload?.error ?? 'ENROLLMENT_FAILED',
    );
  }

  deviceToken = payload.data.token as string;

  // Persisted BEFORE returning, because the API has just revoked this
  // installation's previous live token. Returning a token the device did not
  // keep would mean the sign-in appears to work and the next request fails.
  //
  // A storage failure does not fail the enrolment: the server has already
  // enrolled this device and revoked the old credential, so refusing now would
  // leave the phone with nothing at all. It is reported instead, and the caller
  // can say that this session works and the next launch will need to sign in
  // again.
  let credentialPersisted = true;
  try {
    await credentialStore.saveDeviceToken(deviceToken);
  } catch (error) {
    credentialPersisted = false;
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `⚠️ [oneTeam Mobile] Enrolment succeeded but the credential could not be ` +
        `stored (${detail}). This session will work; the next launch will sign ` +
        `in again.`,
    );
  }

  return { ...(payload.data as EnrollmentResult), credentialPersisted };
}

/**
 * The identity of this installation.
 *
 * WHERE IT COMES FROM, IN ORDER
 * -----------------------------
 *   1. `ONETEAM_DEVICE_ID`, when it is set. This cannot be set in a shipping
 *      build: Metro inlines only `EXPO_PUBLIC_*`, and only as a direct member
 *      expression — this module reads `process.env` through a local alias, which
 *      defeats that inlining entirely, so the value is undefined in a bundle
 *      (measured in plan item 3.1). It is therefore a harness hook, and the
 *      harness has no keychain, which is why it has to be consulted first: the
 *      Node runner names itself this way, and its write tier renames itself
 *      mid-run.
 *   2. What `restoreCredential()` read out of storage at startup — the normal
 *      path, and the only one that is unique per installation.
 *
 * The first is an OVERLAY on the second, not a replacement for it. The
 * installation's own identity is read and minted underneath either way, so
 * removing the variable falls back to the device's real identity instead of
 * leaving the process with none.
 *
 * AND WHAT IT MUST NEVER BE AGAIN
 * -------------------------------
 * It used to fall back to the literal string `demo-device-01`. The doc comment
 * even named the hazard — "two devices sharing a default id would share one
 * identity and one set of audits" — and then shipped it anyway, because there
 * was no storage to put a real one in.
 *
 * The hazard was worse than that sentence says. The API allows exactly one live
 * token per `device_id` (`device_tokens_active_device_idx`) and
 * `insertDeviceToken` revokes the previous one as it issues a new one. So every
 * unconfigured phone in a deployment was the same device, and each enrolment
 * **signed the others out**. Two merchandisers starting a shift together could
 * not both stay signed in. They also shared one audit history, so "the audits
 * this device has filed" returned everyone's.
 *
 * Throwing is the point. A caller that has not restored the credential has no
 * identity, and the honest answer is to say so rather than to invent one and let
 * the device act as somebody else.
 */
export function deviceId(): string {
  const id = currentDeviceId();
  if (id) return id;

  throw new MobileApiError(
    'Cihazın identifikatoru hələ oxunmayıb. Tətbiqin başlanğıcında ' +
      '`restoreCredential()` çağırılmalıdır.',
    null,
    'DEVICE_ID_NOT_RESTORED',
  );
}

/**
 * The identity, or null before anything has produced one.
 *
 * For the call sites that need to describe the app rather than call the API —
 * a startup log must not throw because the credential has not been read yet.
 */
export function currentDeviceId(): string | null {
  const fromEnv = (env.ONETEAM_DEVICE_ID || '').trim();
  if (fromEnv) return fromEnv;
  return cachedDeviceId;
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

type Envelope<T> = {
  success?: boolean;
  data?: T;
  message?: string | string[];
  error?: string;
  /**
   * The API puts a few facts beside `data` rather than inside it — a submission
   * reports where the photo went, how far away the device was, and whether the
   * location was verified. The index signature is what lets those be read
   * without pretending the whole payload is one shape.
   */
  [key: string]: unknown;
};

/**
 * Performs an authenticated call and returns the whole envelope.
 *
 * `request` is the usual entry point and unwraps `data`. This exists for the
 * calls whose answer is not only in `data`. It is split this way rather than
 * given its own fetch path so the credential check and the error handling stay
 * in exactly one place — a second copy would be a second chance to forget the
 * token.
 *
 * `allowAnonymous` is the one exception, and there is exactly one caller: the
 * store lookup that runs before this device has any credential (see
 * `getStoreByCode`). It relaxes the check below rather than skipping this
 * function, so that exception still goes through the same parsing, the same
 * timeout and the same error mapping. Nothing else may use it — a second
 * anonymous call would be a credential-free request nobody intended.
 */
async function callApi(
  path: string,
  init: RequestInit = {},
  options: { allowAnonymous?: boolean } = {},
): Promise<Envelope<any>> {
  // Refused here rather than sent unauthenticated and rejected by the API: the
  // caller gets one clear instruction, and no request leaves the device without
  // a credential attached.
  if (!deviceToken && !options.allowAnonymous) {
    throw new MobileApiError(
      'Bu cihaz hələ qeydiyyatdan keçməyib. Mağaza kodunu daxil edib yenidən yoxlayın.',
      null,
      'NOT_ENROLLED',
    );
  }

  const url = `${API_BASE_URL}${path}`;
  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        // Omitted, not sent empty, on the anonymous call: `Authorization:
        // Bearer undefined` is a different request from no header at all, and
        // the API would answer 401 to the first while the second is the
        // deliberate unauthenticated lookup.
        ...(deviceToken ? { Authorization: `Bearer ${deviceToken}` } : {}),
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new MobileApiError(
      `API-yə qoşulmaq mümkün olmadı (${API_BASE_URL}). Səbəb: ${reason}`,
      null,
      'API_UNREACHABLE',
    );
  }

  const text = await response.text();
  let payload: Envelope<any> = {};

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new MobileApiError(
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
    throw new MobileApiError(
      message || `API xətası (HTTP ${response.status})`,
      response.status,
      (payload as any)?.error ?? null,
    );
  }

  return payload;
}

/** The usual entry point: the call's `data`, with everything beside it dropped. */
async function request<T>(
  path: string,
  init: RequestInit = {},
  options: { allowAnonymous?: boolean } = {},
): Promise<T> {
  const payload = await callApi(path, init, options);
  return payload.data as T;
}

// ---------------------------------------------------------------------------
// Presigned direct upload
//
// The photo can reach the bucket two ways, and this client prefers the one that
// keeps the megabytes off the API: ask the API for a short-lived signed URL,
// then PUT the bytes straight to the bucket. The API only mints the URL and
// stores the `publicUrl` we hand back on the submission. This mirrors the bot's
// `src/services/portalApi.ts` deliberately — one shape, kept correct in two
// places. See docs/PRESIGNED-UPLOAD-PLAN-AZ.md.
// ---------------------------------------------------------------------------

/** What `POST photos/presign` hands back — a signed URL plus the address to submit. */
interface PresignedUpload {
  /** The short-lived signed URL to PUT the bytes to, directly on the bucket. */
  uploadUrl: string;
  /** The address the object will be readable at — this becomes the `photoUrl`. */
  publicUrl: string;
  key: string;
  expiresAt: string;
  /** The headers the URL was signed to expect — just `Content-Type` today. */
  requiredHeaders?: Record<string, string>;
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

/**
 * True when the API answered that it has no object store — the expected reply in
 * inline mode, and the one case where falling back to a `data:` URL is correct
 * rather than a symptom. `callApi` copies the envelope's `error` onto the
 * MobileApiError `code`, so this reads that.
 */
function isStorageNotConfigured(error: unknown): boolean {
  return error instanceof MobileApiError && error.code === 'STORAGE_NOT_CONFIGURED';
}

/**
 * Decodes a base64 payload to the raw bytes a binary PUT needs.
 *
 * `Buffer` when it exists (the Node harness), `atob` otherwise (Hermes on the
 * device). Both produce the same bytes; the split is only about which global is
 * present. A `data:` URL is never sent to the bucket — the presigned PUT stores
 * exactly these bytes under the `Content-Type` the URL was signed for.
 */
function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * PUTs the photo bytes straight to the presigned URL.
 *
 * A raw `fetch`, deliberately NOT `callApi`/`request`: the target is the
 * bucket's URL rather than the API's, the signature already rides in its query
 * string so there is no `Authorization` header to add, and the body is binary
 * rather than JSON. The only header the bucket expects is the `Content-Type` the
 * URL was signed to allow, which the API returns as `requiredHeaders`.
 */
async function putToPresignedUrl(
  presigned: PresignedUpload,
  base64: string,
  contentType: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(presigned.uploadUrl, {
      method: 'PUT',
      headers: presigned.requiredHeaders ?? { 'Content-Type': contentType },
      // The bytes, not a data URL — the bucket stores exactly these. The cast is
      // a TS-5.7-ism only: `Uint8Array<ArrayBufferLike>` no longer matches the
      // DOM `BodyInit`'s `ArrayBufferView<ArrayBuffer>`, though both RN's and
      // Node's `fetch` accept the view unchanged at runtime (the bot PUTs the
      // same way). A Blob would sidestep the cast but let fetch overwrite the
      // Content-Type, so the plain view is the closer-to-honest choice.
      body: base64ToBytes(base64) as unknown as BodyInit,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new MobileApiError(
      `Şəkli birbaşa anbara yükləmək mümkün olmadı. Səbəb: ${reason}`,
      null,
      'DIRECT_UPLOAD_UNREACHABLE',
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new MobileApiError(
      `Şəkil anbara yüklənmədi (HTTP ${response.status})` +
        (detail ? `: ${detail.slice(0, 300)}` : ''),
      response.status,
      'DIRECT_UPLOAD_FAILED',
    );
  }
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

/**
 * Where the API put the photo.
 *
 * Not a field of the submission: the API reports it beside `data`. It is
 * captured because the client cannot know whether the deployment has a bucket,
 * and guessing "inline" would write a false provenance record for every
 * s3-backed audit.
 */
interface ApiPhotoStorage {
  driver: string;
  bytes: number;
  offloaded: boolean;
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

function toMobileSubmission(
  submission: ApiSubmission,
  photoStorage?: ApiPhotoStorage,
): MobileSubmission {
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
    metadata: {
      ...(submission.metadata ?? {}),
      // What the API actually did with the photo, recorded only when it said.
      ...(photoStorage
        ? {
            storage: photoStorage.driver,
            storage_bytes: photoStorage.bytes,
            storage_offloaded: photoStorage.offloaded,
          }
        : {}),
    },
    // The API has no column for this: a submission is "synced" the moment it is
    // accepted, and the queue only exists on the device.
    is_offline_synced: true,
  };
}

/**
 * Generates a client-side idempotency key for field submissions.
 */
export function newIdempotencyKey(): string {
  return `mob-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

class MobilePortalApi {
  /** For startup logs. Never includes the token. */
  describeTarget(): string {
    // `currentDeviceId`, not `deviceId`: a log line must not throw because the
    // credential has not been read yet. It says so instead.
    return `${API_BASE_URL} (device ${currentDeviceId() ?? 'not restored yet'})`;
  }

  /** Confirms the API answers and the credential is accepted. */
  async ping(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      // `/api/portal/field/whoami`, not `/api/portal/stores`. The stores route is
      // the supervisor API, and a device credential is refused there now: a
      // merchandiser's installation has no business reading the whole chain's
      // store list, and using it as a liveness probe was only ever possible
      // because nothing was checking.
      await request<unknown>('/api/portal/field/whoami');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Resolves a store code typed by a field worker. Null when no such store.
   *
   * TWO ROUTES, AND THE CHOICE IS NOT AN OPTIMISATION
   * ------------------------------------------------
   * `GET /api/portal/field/store` is authenticated, and the login screen needs
   * this answer BEFORE it can have a credential — enrolling is what issues one.
   * Measured on 2026-09-19, that ordering made the first sign-in on a fresh
   * installation impossible: `callApi` refuses to send a request with no token,
   * so the screen showed "Sistemə qoşulmaq mümkün olmadı" no matter what the
   * store code was, and the device could never get past it.
   *
   * So a device with no token asks `store-lookup` instead, which sits beside
   * `enroll` and is gated by the same enrolment secret. A device that already
   * has a token keeps using the authenticated route: the anonymous one is for
   * the one moment when no credential exists, not a way to stop sending one.
   */
  async getStoreByCode(storeCode: string, enrollmentSecret?: string): Promise<MobileStore | null> {
    const code = storeCode.trim().toUpperCase();
    if (!code) return null;

    let store: ApiStore | null;
    if (deviceToken) {
      store = await request<ApiStore | null>(
        `/api/portal/field/store?code=${encodeURIComponent(code)}`,
      );
    } else {
      // The same order `enroll` uses: what the operator typed on this screen,
      // then what an earlier installation stored, then the harness variable.
      const secret =
        enrollmentSecret?.trim() ||
        (await credentialStore.enrollmentSecret()) ||
        env.ONETEAM_ENROLLMENT_SECRET ||
        undefined;

      store = await request<ApiStore | null>(
        `/api/portal/field/store-lookup?code=${encodeURIComponent(code)}`,
        { headers: secret ? { 'X-Enrollment-Secret': secret } : {} },
        { allowAnonymous: true },
      );
    }

    // A deactivated store must not accept audits even though it still resolves.
    if (!store || store.is_active === false) return null;
    return toMobileStore(store);
  }

  async getTasksForStore(storeId: string): Promise<MobileTask[]> {
    const tasks = await request<ApiTask[]>(
      `/api/portal/field/tasks?storeId=${encodeURIComponent(storeId)}`,
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
      `/api/portal/field/submissions?deviceId=${encodeURIComponent(deviceId())}&limit=${limit}`,
    );
    return (submissions ?? [])
      .map((submission) => toMobileSubmission(submission))
      .filter((submission) => submission.store_id === storeId);
  }

  /** Every audit this device has filed, across stores. */
  async getAllSubmissions(limit = 50): Promise<MobileSubmission[]> {
    const submissions = await request<ApiSubmission[]>(
      `/api/portal/field/submissions?deviceId=${encodeURIComponent(deviceId())}&limit=${limit}`,
    );
    return (submissions ?? []).map((submission) => toMobileSubmission(submission));
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

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
    taskId: string,
  ): Promise<{ taskId: string; currentState: string; advanced: boolean }> {
    return request<{ taskId: string; currentState: string; advanced: boolean }>(
      `/api/portal/field/tasks/${encodeURIComponent(taskId)}/acknowledge`,
      { method: 'POST', body: JSON.stringify({ deviceId: deviceId() }) },
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
   *
   * HOW A REAL CAPTURE TRAVELS
   * --------------------------
   * A real capture (`base64` present) is PUT straight to the bucket through a
   * presigned URL, so the megabytes never cross the API body, and the returned
   * `publicUrl` becomes the `photoUrl`. Two things send it to the inline `data:`
   * path instead: an API with no bucket (`STORAGE_NOT_CONFIGURED`, the correct
   * answer in inline mode — silent) and a direct PUT that fails (logged, and the
   * API still offloads the data URL on its side, so the audit is never lost).
   * The placeholder is never presigned — it always goes inline.
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
        'CAPTURE_NOT_AVAILABLE',
      );
    }

    // Prefer the presigned direct upload for a real capture. On STORAGE_NOT_CONFIGURED
    // this is expected and silent; on any other failure we log and fall through to
    // inline rather than lose the audit (the API offloads the data URL on its side).
    if (base64) {
      const scope = fileName?.includes('/') ? fileName.replace(/\/[^/]*$/, '') : undefined;
      try {
        const presigned = await requestPresignedUpload({ contentType, scope });
        await putToPresignedUrl(presigned, base64, contentType);
        return { photoUrl: presigned.publicUrl, origin: 'device' };
      } catch (error) {
        if (!isStorageNotConfigured(error)) {
          console.warn(
            `[oneTeam Mobile] Presigned upload failed, falling back to inline: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        // fall through to the inline data URL below
      }
    }

    const payload = base64 ?? PLACEHOLDER_JPEG_BASE64;
    const dataUrl = `data:${contentType};base64,${payload}`;

    if (dataUrl.length > MAX_PHOTO_BYTES) {
      throw new MobileApiError(
        `Şəkil çox böyükdür (${Math.round(dataUrl.length / 1024)} KB). ` +
          `Maksimum ${Math.round(MAX_PHOTO_BYTES / 1024)} KB qəbul edilir.`,
        413,
        'PHOTO_TOO_LARGE',
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
    idempotencyKey?: string;
  }): Promise<MobileSubmission> {
    const gps = params.gps;
    const hasFix = typeof gps?.latitude === 'number' && typeof gps?.longitude === 'number';

    // Anti-fraud location quality, sent alongside the fix rather than instead of
    // it. These are ADDED fields — the server reads them when present and older
    // deployments ignore them — so the existing `latitude`/`longitude`/
    // `locationUnverified` shape is unchanged.
    //
    //   - `locationAccuracy`  — the reported accuracy in meters, so a precise fix
    //     and a vague one are no longer indistinguishable on the server.
    //   - `locationLowConfidence` — the fix is missing an accuracy reading or is
    //     worse than the threshold. A low-confidence fix is NOT refused (a
    //     basement audit is still evidence), it is flagged as weaker.
    //   - `locationMocked` — the platform reported this as a mock/spoofed fix
    //     (Android only; absent on iOS). Only sent when the platform actually
    //     said something, so `undefined` is never asserted as "genuine".
    //
    // `Number.isFinite` and not `typeof … === 'number'`, matching
    // `isLowConfidenceFix`: a NaN accuracy is a `number` by typeof but is not a
    // measurement, and `JSON.stringify` would turn it into a literal `null` on
    // the wire — the server would store "precision unknown" under a key that
    // claims to hold a number.
    const accuracyMeters = hasFix && Number.isFinite(gps?.accuracy) ? gps?.accuracy : undefined;
    const locationLowConfidence = hasFix && gps ? isLowConfidenceFix(gps) : undefined;
    const locationMocked = hasFix && typeof gps?.mocked === 'boolean' ? gps.mocked : undefined;

    // The retry guard, and the reason this function has a key parameter at all.
    //
    // The server dedupes on this: `EvidenceService.submitEvidence` returns the
    // evidence it already created for a key it has seen, instead of filing a
    // second one. Without it every resend — a timeout where the POST actually
    // landed, a double-tap, a queued item drained twice — became another
    // evidence row AND another advance of the task, and a supervisor saw an
    // audit they had never taken.
    //
    // A caller that does not supply one still gets a key rather than no key:
    // the default makes a plain single submission safe to retry, and a caller
    // that IS retrying (the camera screen, the offline drain) passes its own so
    // the retries collapse onto one submission.
    const idempotencyKey = params.idempotencyKey ?? newIdempotencyKey();

    const envelope = await callApi('/api/portal/field/submissions', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: deviceId(),
        storeTaskId: params.taskId,
        photoUrl: params.photoUrl,
        photoType: 'standard',
        latitude: hasFix && gps ? gps.latitude : undefined,
        longitude: hasFix && gps ? gps.longitude : undefined,
        locationUnverified: !hasFix,
        locationAccuracy: accuracyMeters,
        locationLowConfidence,
        locationMocked,
        idempotencyKey,
        checklistAnswers: params.checklistAnswers ?? [],
        metadata: {
          ...(params.metadata ?? {}),
          device_id: deviceId(),
          photo_origin: params.photoOrigin ?? 'device',
          distance_from_store_meters: params.distanceFromStoreMeters,
          // No `storage` claim here. The client does not know whether this
          // deployment has a bucket, so asserting "inline" would be a guess
          // recorded as provenance. The API answers, and `toMobileSubmission`
          // writes what it actually did.
        },
      }),
    });

    const result = envelope.data as ApiSubmission | undefined;
    if (!result?.id) {
      throw new MobileApiError('Audit qeydə alınmadı', 500, 'SUBMISSION_FAILED');
    }

    // Where the photo went is a sibling of `data`, so it has to be read from the
    // envelope. Without this the client could not record real provenance and
    // would have to guess at it — which is exactly what it used to do.
    const photoStorage = envelope.photoStorage as ApiPhotoStorage | undefined;
    return toMobileSubmission(result, photoStorage);
  }
}

export const mobileApi = new MobilePortalApi();
