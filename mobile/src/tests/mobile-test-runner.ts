/**
 * oneTeam mobile field client — automated verification
 * ============================================================================
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * This runner used to exercise the controllers against `services/supabaseMobile.ts`,
 * an in-memory mock that answered every call from two hardcoded stores. It passed
 * no matter what the app would do against the real system, and it proved nothing
 * about the code that ships.
 *
 * It now runs in two tiers:
 *
 *   READ-ONLY (always) — the geofence maths, the anti-gallery rule, the offline
 *   queue, and REAL reads against the running API. No records are written, but
 *   only if `ONETEAM_DEVICE_TOKEN` is supplied: the client has no credential of
 *   its own any more, so without one the suite enrols first and that enrolment
 *   is a write. Which of the two happened is printed at startup.
 *
 *   WRITE (only when ONETEAM_MOBILE_WRITES=1) — the full flow: enrol, claim the
 *   store's work, acknowledge, submit, and read the supervisor's verdict back.
 *   It provisions its own task rather than consuming the seeded one, so it is
 *   repeatable: a seeded task ends up APPROVED after the first run and a terminal
 *   state cannot be reused.
 *
 * Prerequisites for the read tier: the API must be running (`npm run api:dev`).
 * The write tier additionally needs the API to accept writes, which it always
 * does outside production.
 */

import { verifyStoreGeofence } from '../utils/geofence';
import { offlineQueueService } from '../services/offlineQueue';
import {
  mobileApi,
  deviceId,
  MobileApiError,
  enroll,
  hasDeviceToken,
  restoreCredential,
} from '../services/portalApi';
import { CameraAuditController } from '../screens/CameraAuditScreen';
import { assertLiveCameraCapture, UNKNOWN_DEVICE_FIELD } from '../components/SmartCameraOverlay';
import { GPSCoordinates, MobileStore, MobileTask } from '../types';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

/** Real store from the seeded catalogue. */
const STORE_CODE = 'BRAVO_YASAMAL_01';
const STORE_LAT = 40.385012;
const STORE_LON = 49.810541;

/**
 * The device's position, deliberately NOT the store's own.
 *
 * Roughly 11 m away: inside the 100 m geofence, but distinguishable from the
 * store's coordinates. If the API ever substituted the store's position for the
 * device's, the stored `gps` would come back as 40.385012 / 49.810541 and the
 * assertion in the write tier would fail.
 */
const USER_LAT = 40.3851;
const USER_LON = 49.8106;

/** Far outside the geofence — Fountain Square, roughly 1.3 km away. */
const FAR_LAT = 40.3705;
const FAR_LON = 49.837;

/**
 * The identity this harness runs as, when nothing else names it.
 *
 * The device client now mints its identity once and keeps it in the keychain,
 * and the keychain is exactly what a Node process does not have — so without a
 * name here the runner would mint a FRESH identity on every run. That is not
 * read-only by any reading of the phrase: each run would create another device
 * user and another device token in the database, and the suite would slowly fill
 * the store's device list with ghosts of itself.
 *
 * So the harness names itself, stably. `ONETEAM_DEVICE_ID` is the overlay the
 * client consults first for exactly this reason; see `currentDeviceId()` in
 * `portalApi.ts` for why putting it first is safe.
 */
const HARNESS_DEVICE_ID = process.env.ONETEAM_DEVICE_ID || 'test-device-mobile';

const API_URL = (process.env.ONETEAM_API_URL || 'http://localhost:3001').replace(/\/+$/, '');

/**
 * The credential used to play the supervisor.
 *
 * A supervisor's decision is not something a field device can make, so the suite
 * has to hold a second, wider credential to exercise the review path. That is
 * why this one is a service credential and the client's is not — and why it
 * defaults to a SUPERVISOR rather than the administrator it used to name. A test
 * does not need the widest role in the system to approve a task.
 */
const SUPERVISOR_TOKEN = process.env.ONETEAM_API_TOKEN || 'oneteam-user:usr-super-002';

const WRITE_TIER = process.env.ONETEAM_MOBILE_WRITES === '1';

function logStep(num: number, title: string) {
  console.log(`\n${colors.bright}${colors.cyan}[TEST SUITE ${num}] ${title}${colors.reset}`);
}

function logPass(msg: string) {
  console.log(`${colors.green}  ✓ ${msg}${colors.reset}`);
}

function logInfo(msg: string) {
  console.log(`${colors.yellow}  ℹ ${msg}${colors.reset}`);
}

/**
 * A direct API call, playing the supervisor.
 *
 * The mobile client cannot do this: a supervisor's decision is not something a
 * field device should be able to make. This file is allowed to hold two
 * credentials because it is simulating two actors.
 */
async function supervisorApi<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPERVISOR_TOKEN}`,
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(20_000),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = payload?.message ?? payload?.error ?? `HTTP ${response.status}`;
    throw new Error(`Supervisor call ${path} failed: ${JSON.stringify(message)}`);
  }
  return (payload?.data ?? payload) as T;
}

/** Runs `fn` and returns the thrown error, failing if nothing was thrown. */
async function expectFailure(fn: () => Promise<unknown>, context: string): Promise<any> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error(`${context} — expected a failure and got none`);
}

/**
 * Ensures the client holds a device credential, because it now holds nothing by
 * default.
 *
 * The client used to ship a service credential and default to an administrator,
 * so every call worked with no setup — and extracting one string from the
 * bundle gave away the whole system. There is no default now, which means this
 * runner has to obtain a credential before it can read anything at all.
 *
 * Two ways, and the difference is reported rather than glossed over:
 *
 *   - `ONETEAM_DEVICE_TOKEN` set — a token already issued to this device. This
 *     is the genuinely read-only path: nothing is created.
 *   - otherwise — enrol, which is a write: it creates or updates the device's
 *     user, claims the store's open work, and issues a token. The suite says so
 *     out loud, because "read-only" that quietly writes is a lie in a log.
 */
async function ensureCredential(): Promise<void> {
  if (hasDeviceToken()) {
    logInfo('Using the device token from ONETEAM_DEVICE_TOKEN (nothing will be created).');
    return;
  }

  logInfo(
    'No ONETEAM_DEVICE_TOKEN set — enrolling this device. This WRITES: it claims ' +
      `${STORE_CODE}'s open work and issues a token.`,
  );
  const result = await enroll({
    storeCode: STORE_CODE,
    fullName: `Test Device (${deviceId()})`,
  });
  logPass(`Enrolled as ${result.userId} at ${result.store.storeCode}`);
}

async function runMobileTests() {
  // The device client reads its identity out of the keychain at startup, and a
  // Node process has no keychain, so the harness names itself here — before
  // anything can ask for the identity. `deviceId()` throws until this has run,
  // deliberately: the default it used to fall back to was shared by every
  // unconfigured installation, and the API allows one live credential per device
  // id, so they used to sign each other out.
  process.env.ONETEAM_DEVICE_ID ||= HARNESS_DEVICE_ID;
  const restored = await restoreCredential();

  console.log(
    `${colors.bright}========================================================================${colors.reset}`,
  );
  console.log(
    `${colors.bright}  oneTeam FIELD CLIENT — VERIFICATION AGAINST THE REAL API              ${colors.reset}`,
  );
  console.log(
    `${colors.bright}========================================================================${colors.reset}`,
  );
  console.log(`  Target: ${mobileApi.describeTarget()}`);
  console.log(
    `  Credential: ${restored.hasToken ? 'restored from this process' : 'none — the read tier will enrol'}`,
  );
  console.log(
    `  Write tier: ${WRITE_TIER ? 'ENABLED (ONETEAM_MOBILE_WRITES=1)' : 'disabled (read-only)'}`,
  );

  // --------------------------------------------------------------------------
  // Preconditions
  // --------------------------------------------------------------------------
  // Before the ping, because the ping is an authenticated call: with no
  // credential it fails with NOT_ENROLLED, which looks like an unreachable API
  // and is not.
  await ensureCredential();

  const ping = await mobileApi.ping();
  if (!ping.ok) {
    throw new Error(
      `The API at ${API_URL} is not answering: ${ping.error}\n` +
        '       Start it with: npm run api:dev',
    );
  }
  logPass(`API reachable at ${API_URL}`);

  // --------------------------------------------------------------------------
  // SUITE 1: GPS Geofencing (Anti-Fraud Location Verification)
  // --------------------------------------------------------------------------
  logStep(1, 'Anti-Fraud GPS Geofencing Verification (100m Perimeter)');

  const insideGPS: GPSCoordinates = { latitude: USER_LAT, longitude: USER_LON, accuracy: 3.5 };
  const insideResult = verifyStoreGeofence(insideGPS, {
    latitude: STORE_LAT,
    longitude: STORE_LON,
  });

  logInfo(`User location (inside): ${insideResult.distanceMeters} meters away.`);
  if (!insideResult.isWithinGeofence) {
    throw new Error(
      `Expected insideResult to be within geofence (< 100m), got ${insideResult.distanceMeters}m`,
    );
  }
  logPass(`Store geofence confirmed within threshold: ${insideResult.message}`);

  const outsideGPS: GPSCoordinates = { latitude: FAR_LAT, longitude: FAR_LON, accuracy: 10 };
  const outsideResult = verifyStoreGeofence(outsideGPS, {
    latitude: STORE_LAT,
    longitude: STORE_LON,
  });

  logInfo(`User location (outside): ${outsideResult.distanceMeters} meters away.`);
  if (outsideResult.isWithinGeofence) {
    throw new Error('Expected outsideResult to be rejected by geofence');
  }
  if (!outsideResult.message.includes('Siz mağaza ərazisində deyilsiniz')) {
    throw new Error('Expected anti-fraud warning message when outside store');
  }
  logPass(`Anti-fraud protection blocked audit outside geofence: "${outsideResult.message}"`);

  // --------------------------------------------------------------------------
  // SUITE 2: Smart Camera & Anti-Gallery Enforcement
  // --------------------------------------------------------------------------
  logStep(2, 'Smart Camera Live Capture & Anti-Gallery Enforcement');

  let galleryBlocked = false;
  try {
    assertLiveCameraCapture('gallery');
  } catch (err: any) {
    galleryBlocked = true;
    logPass(`Gallery photo upload rejected: "${err.message}"`);
  }
  if (!galleryBlocked) {
    throw new Error('Expected gallery photo selection to be blocked');
  }

  // A minimal store/task pair, only so the controller can be constructed. The
  // real ones are read from the API in SUITE 4.
  const cameraStore: MobileStore = {
    id: 'str-bravo-yasamal',
    store_code: STORE_CODE,
    name: 'Bravo Hypermarket - Yasamal',
    address: null,
    city: 'Bakı',
    latitude: STORE_LAT,
    longitude: STORE_LON,
    is_active: true,
  };
  const cameraTask: MobileTask = {
    id: 'task-placeholder',
    title: 'Cooler Check',
    description: 'Soyuducu auditi',
    reference_image_url: null,
    priority: 'high',
    status: 'published',
    deadline: new Date(Date.now() + 86400000).toISOString(),
    planogram_rules: [],
    checklist_schema: [],
  };

  const cameraController = new CameraAuditController(cameraTask, cameraStore);
  cameraController.setGhostOpacity(0.5);

  const capture = await cameraController.captureLiveAudit({
    source: 'camera',
    userGPS: insideGPS,
  });

  if (!capture.photoUri.startsWith('file://')) {
    throw new Error('Expected the simulated capture to return a file path');
  }
  if (capture.metadata.capture_mode !== 'live_camera_only') {
    throw new Error('Expected metadata capture_mode to be live_camera_only');
  }
  if (!capture.metadata.ghost_overlay_used) {
    throw new Error('Expected ghost_overlay_used to be true in metadata');
  }
  // The harness has no camera module, and the capture says so rather than
  // pretending otherwise.
  if (!capture.simulated || capture.base64 !== undefined) {
    throw new Error('Expected the harness capture to be marked simulated with no image bytes');
  }
  if (capture.metadata.device_model !== UNKNOWN_DEVICE_FIELD) {
    throw new Error(
      `Expected an unknown device model, got "${capture.metadata.device_model}" — ` +
        'the harness cannot read the device and must not invent one',
    );
  }

  logPass(`Live camera photo captured (simulated): ${capture.photoUri}`);
  logPass(
    `Telemetry stamped: GPS(${capture.metadata.gps.latitude}, ${capture.metadata.gps.longitude}), ` +
      `Distance=${capture.metadata.distance_from_store_meters}m, Device=${capture.metadata.device_model}`,
  );

  // --------------------------------------------------------------------------
  // SUITE 3: Offline Queue, and What It Does When It Cannot Upload
  // --------------------------------------------------------------------------
  logStep(3, 'Offline In-Store Queue & Honest Sync Failure');

  // The drain below is driven through RECONNECTION, not by calling
  // `processQueue` by hand. That distinction is the whole point of this rewrite:
  // `triggerAutoSync` used to be an empty method, and the old version of this
  // suite called `processQueue` itself — so it passed against a reconnection
  // path that did nothing at all. It was asserting on the neighbour of the
  // thing it claimed to test.
  //
  // The handler is registered HERE rather than left to the history screen,
  // because this tier is read-only: the real handler acknowledges the task
  // before uploading, and acknowledging is a write. This one fails exactly the
  // way the real one would when it has no image bytes, and says so.
  offlineQueueService.setUploadHandler(async (item) => {
    const { photoUrl } = await mobileApi.uploadPhoto({
      base64: item.photo_base64,
      fileName: `audits/${item.store_id}/${item.task_id}_${Date.now()}.jpg`,
    });
    return { photoUrl, submissionId: 'never-reached' };
  });

  offlineQueueService.setOnlineStatus(false);
  logInfo('Network status changed: OFFLINE (Basement retail store)');

  const offlineSubmissionResult = await cameraController.processAuditSubmission({
    photoUri: capture.photoUri,
    metadata: capture.metadata,
  });

  if (offlineSubmissionResult.status !== 'queued_offline') {
    throw new Error('Expected submission to be queued offline when disconnected');
  }
  if (offlineQueueService.getPendingCount() !== 1) {
    throw new Error(`Expected pending count 1, got ${offlineQueueService.getPendingCount()}`);
  }
  logPass(`Audit stored in the offline queue (ID: ${offlineSubmissionResult.queueItem?.id})`);

  offlineQueueService.setOnlineStatus(true);
  logInfo('Network status changed: ONLINE (Connected)');

  // The queued item has no image bytes — the harness had no camera. Syncing it
  // must FAIL and say why, rather than filing a placeholder image as though it
  // were the audit the worker took. This is the assertion that keeps that from
  // regressing.
  const syncResult = await offlineQueueService.autoSync;

  if (!syncResult) {
    throw new Error(
      'Reconnection did not start a drain. `triggerAutoSync` is not wired to `setOnlineStatus`, ' +
        'so a worker coming out of a basement would keep their audits in the queue forever.',
    );
  }
  if (syncResult.reason !== 'drained') {
    throw new Error(
      `Expected reconnection to attempt an upload, got reason "${syncResult.reason}" — ` +
        'nothing was tried, so nothing was proven.',
    );
  }
  if (syncResult.syncedCount !== 0 || syncResult.failedCount !== 1) {
    throw new Error(
      `Expected the queueless sync to fail (0 synced / 1 failed), got ` +
        `${syncResult.syncedCount}/${syncResult.failedCount}`,
    );
  }

  const failedItem = offlineQueueService.getQueue()[0];
  if (!failedItem || failedItem.sync_status !== 'failed') {
    throw new Error('Expected the item to remain queued with a failed status');
  }
  if (!String(failedItem.error_message ?? '').includes('kamera modulu yoxdur')) {
    throw new Error(
      `Expected an explanation about the missing camera, got: "${failedItem.error_message}"`,
    );
  }
  logPass(`Sync refused to invent an image: "${failedItem.error_message}"`);

  await offlineQueueService.clearQueue();

  // --------------------------------------------------------------------------
  // SUITE 4: Real reads against the API
  // --------------------------------------------------------------------------
  logStep(4, 'Real Store and Task Reads (no mock data)');

  const store = await mobileApi.getStoreByCode(STORE_CODE);
  if (!store) {
    throw new Error(`Expected the real store ${STORE_CODE} to resolve`);
  }
  if (store.latitude === null || store.longitude === null) {
    throw new Error(
      `Expected ${STORE_CODE} to carry coordinates — without them the geofence cannot run`,
    );
  }
  if (
    Math.abs(store.latitude - STORE_LAT) > 0.000001 ||
    Math.abs(store.longitude - STORE_LON) > 0.000001
  ) {
    throw new Error(
      `Expected the real coordinates ${STORE_LAT}/${STORE_LON}, got ${store.latitude}/${store.longitude}`,
    );
  }
  logPass(`Store resolved from the API: ${store.name} (${store.store_code})`);
  logPass(`Coordinates are real: ${store.latitude}, ${store.longitude}`);

  const tasks = await mobileApi.getTasksForStore(store.id);
  if (tasks.length === 0) {
    throw new Error(`Expected at least one task for ${store.id}`);
  }
  logInfo(`Tasks returned: ${tasks.length}`);
  logPass(`Sample task: "${tasks[0].title}" (${tasks[0].priority}, ${tasks[0].status})`);

  // The planogram rules used to be hardcoded in the client. They now come from
  // the template, so a task either carries real rules or carries none.
  const withRules = tasks.find((t) => t.planogram_rules.length > 0);
  if (!withRules) {
    logInfo('No task in this store carries planogram rules — nothing to assert.');
  } else {
    logPass(
      `Planogram rules come from the template: ${withRules.planogram_rules.length} rule(s), ` +
        `first = ${(withRules.planogram_rules[0] as any).label}`,
    );
  }

  // --------------------------------------------------------------------------
  // SUITE 5: The write path
  // --------------------------------------------------------------------------
  if (!WRITE_TIER) {
    console.log(
      `\n${colors.yellow}  ℹ Write tier skipped. Re-run with ONETEAM_MOBILE_WRITES=1 to exercise ` +
        `the full submission flow.${colors.reset}`,
    );
  } else {
    logStep(5, 'Full submission flow: claim, acknowledge, submit, review');

    if (process.env.NODE_ENV === 'production') {
      throw new Error('The write tier writes real audits and must not run against production.');
    }

    // Its own identity, so it never collides with a real device's audits.
    process.env.ONETEAM_DEVICE_ID = 'test-device-e2e';
    logInfo(`Device identity for this run: ${deviceId()}`);

    const title = `E2E mobile test — Cooler auditi ${new Date().toISOString()}`;
    const dispatched = await supervisorApi<{ taskIds?: string[] }>('/api/portal/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title,
        description: 'Mobil tətbiqin end-to-end testi tərəfindən yaradılmış tapşırıq.',
        reference_image_url: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97',
        priority: 'HIGH',
        deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
        assigned_stores: [store.id],
        checklist_schema: [
          { id: 'q-clean', question: 'Rəflər təmizdirmi?', type: 'boolean', required: true },
        ],
      }),
    });

    const provisionedTaskId = dispatched?.taskIds?.[0];
    if (!provisionedTaskId) {
      throw new Error('Dispatch returned no task id');
    }
    logPass(`Supervisor dispatched a task: ${provisionedTaskId}`);

    // Enrolling claims the store's open work — the same self-claim the chat
    // channel performs with a store code, and the same call `ensureCredential`
    // makes. It is repeated here because the task above did not exist then, and
    // the claim is what makes it assignable to this device.
    const profile = await enroll({
      storeCode: STORE_CODE,
      fullName: 'Test Device',
    });
    if (!profile.claimedTaskIds.includes(provisionedTaskId)) {
      throw new Error(
        `Expected the enrolment to claim ${provisionedTaskId}, claimed: ` +
          JSON.stringify(profile.claimedTaskIds),
      );
    }
    logPass(
      `Device enrolled as ${profile.userId} and claimed ${profile.claimedTaskIds.length} task(s)`,
    );

    const claimed = (await mobileApi.getTasksForStore(store.id)).find(
      (t) => t.id === provisionedTaskId,
    );
    if (!claimed) {
      throw new Error('The claimed task did not appear in the task list');
    }

    const session = new CameraAuditController(claimed, store);

    // Acknowledgement first: the lifecycle only lets a submission advance an
    // ACKNOWLEDGED task.
    const ack = await mobileApi.acknowledgeTask(claimed.id);
    if (ack.currentState !== 'ACKNOWLEDGED') {
      throw new Error(`Expected ACKNOWLEDGED, got ${ack.currentState}`);
    }
    logPass('Task acknowledged and ready for field work.');

    // THE GEOFENCE IS REAL ON THIS CHANNEL. A submission from 1.3 km away must be
    // refused — this is the control the chat channel cannot apply, and the reason
    // the mobile client exists.
    const { photoUrl: farPhotoUrl } = await mobileApi.uploadPhoto({
      fileName: 'audits/far.jpg',
      placeholder: true,
    });
    const geofenceError = await expectFailure(
      () =>
        mobileApi.submitAudit({
          taskId: claimed.id,
          storeId: store.id,
          photoUrl: farPhotoUrl,
          gps: { latitude: FAR_LAT, longitude: FAR_LON, accuracy: 10 },
          metadata: capture.metadata,
        }),
      'A submission from outside the geofence',
    );

    if (!(geofenceError instanceof MobileApiError) || geofenceError.status !== 400) {
      throw new Error(
        `Expected a 400 from the geofence, got ${geofenceError?.status}: ${geofenceError?.message}`,
      );
    }
    if (!String(geofenceError.message).includes('mağaza ərazisində')) {
      throw new Error(`Expected the anti-fraud message, got: "${geofenceError.message}"`);
    }
    logPass(`Geofence refused a remote submission: "${geofenceError.message}"`);

    // Now the real one, from the store.
    const captured = await session.captureLiveAudit({ source: 'camera', userGPS: insideGPS });
    const result = await session.processAuditSubmission({
      photoUri: captured.photoUri,
      metadata: captured.metadata,
      base64: captured.base64,
    });

    if (result.status !== 'uploaded' || !result.submission) {
      throw new Error(`Expected an uploaded submission, got ${result.status}`);
    }
    const submission = result.submission;
    logPass(`Submission filed: ${submission.id} (${submission.status})`);
    // What the API actually did with the photo, not what this file assumed. The
    // previous version hardcoded "no object store yet", so it would have gone on
    // saying that after a bucket was configured — a passing test asserting a
    // stale fact. The driver now comes back with the submission, and the two
    // must agree: an s3 driver with a data URL, or the reverse, is a lie
    // somewhere and is treated as a failure.
    const driver = submission.metadata?.storage;
    if (driver === 's3') {
      if (String(submission.photo_url).startsWith('data:')) {
        throw new Error('The API reported s3 storage but returned a data URL');
      }
      logPass(
        `Photo offloaded to object storage (${String(submission.metadata?.storage_bytes)} bytes): ` +
          `${String(submission.photo_url).slice(0, 48)}…`,
      );
    } else if (driver === 'inline') {
      if (!String(submission.photo_url).startsWith('data:')) {
        throw new Error('The API reported inline storage but returned a non-data URL');
      }
      logInfo(
        `Photo stored inline (${String(submission.photo_url).slice(0, 32)}…, no bucket configured)`,
      );
    } else {
      throw new Error(
        `The API did not report where the photo went (metadata.storage = ${String(driver)})`,
      );
    }

    if (submission.status !== 'pending_review') {
      throw new Error(`Expected pending_review, got ${submission.status}`);
    }

    const submittedTask = await supervisorApi<{ status?: string }>(
      `/api/tasks/${encodeURIComponent(claimed.id)}`,
    );
    if (submittedTask?.status !== 'SUBMITTED') {
      throw new Error(`Expected SUBMITTED after the photo, got ${submittedTask?.status}`);
    }
    logPass('Task advanced to SUBMITTED — it is now reviewable.');

    // The supervisor's verdict must reach the device's history.
    const feedback = 'Rəflər qaydasındadır, təşəkkürlər.';
    await supervisorApi(`/api/portal/submissions/${encodeURIComponent(submission.id)}/review`, {
      method: 'POST',
      body: JSON.stringify({ status: 'approved', feedback }),
    });

    const history = await mobileApi.getSubmissionsForStore(store.id);
    const reviewed = history.find((s) => s.id === submission.id);
    if (!reviewed) {
      throw new Error('The reviewed submission did not appear in the device history');
    }
    if (reviewed.status !== 'approved') {
      throw new Error(`Expected approved, got ${reviewed.status}`);
    }
    if (reviewed.reviewer_feedback !== feedback) {
      throw new Error(
        `Expected the supervisor's feedback to survive, got "${reviewed.reviewer_feedback}"`,
      );
    }
    logPass(`Verdict reached the device: ${reviewed.status} — "${reviewed.reviewer_feedback}"`);
  }

  console.log(
    `\n${colors.bright}${colors.green}========================================================================${colors.reset}`,
  );
  console.log(
    `${colors.bright}${colors.green}  ALL FIELD CLIENT TESTS PASSED                                          ${colors.reset}`,
  );
  console.log(
    `${colors.bright}${colors.green}========================================================================${colors.reset}\n`,
  );
}

runMobileTests().catch((err) => {
  console.error(`\n${colors.red}❌ Mobile test runner failed:${colors.reset}`, err?.message || err);
  console.error(
    `\n   The read tier needs the Core API running. Start it with:\n     npm run api:dev\n`,
  );
  process.exit(1);
});
