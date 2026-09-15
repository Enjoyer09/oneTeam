/**
 * oneTeam mobile field client — the offline queue
 * ============================================================================
 *
 * WHAT WAS WRONG
 * --------------
 * Plan item 3.1 measured this file rather than assuming it worked, and found
 * three separate untruths:
 *
 *   1. `private queue: QueueItem[] = []` — the queue lived in a module-level
 *      array. Nothing was ever written anywhere. A field worker in a basement
 *      store could capture three audits, watch the app list them, and lose every
 *      one of them to a crash, a low-memory kill, or an iOS upgrade. The README
 *      said "submissions are queued securely in local storage".
 *   2. `triggerAutoSync()` was an empty method with a comment claiming it
 *      initiated a sync. `setOnlineStatus(false -> true)` called it and it did
 *      nothing. The README said the app "automatically detects network
 *      reconnection and triggers background uploads".
 *   3. There was no 50 MB limit, so the plan's third requirement was simply
 *      absent.
 *
 * So 3.3 is not "move the queue to AsyncStorage". It is WRITE THE QUEUE.
 *
 * WHY THE STORAGE IS AN INTERFACE
 * -------------------------------
 * The same reason `credentialStore` takes a `SecureKeyValueStore`: the rules
 * worth testing cannot be tested on a phone from a build machine. The platform
 * supplies a `QueueStorage` — `queueStorage.ts` for the app, `MemoryQueueStorage`
 * for tests and for the Node harness — and every rule in this file stays
 * reachable by a suite that runs without a device.
 *
 * Only the app entry imports the native adapter. Nothing else under `src/` may.
 *
 * THE FOUR DURABILITY RULES
 * -------------------------
 * These are the reason this file is longer than the array it replaced. Each one
 * is a way an audit can be lost or duplicated:
 *
 *   1. PERSIST IS AWAITED, AND IT THROWS. A queue that is not on disk has not
 *      been queued, and `enqueueSubmission` rolls the in-memory entry back
 *      rather than reporting a success that will not survive the next launch.
 *      This is the same rule as `enqueue` in the database layer, for the same
 *      reason.
 *   2. THE 50 MB LIMIT REFUSES THE NEW ITEM. It does not evict the oldest. An
 *      eviction would silently discard an audit the worker already took, which
 *      is precisely the failure this queue exists to prevent; a refusal is
 *      something the worker can see and act on.
 *   3. THE MARKER IS WRITTEN BEFORE THE UPLOAD, per item. An item goes
 *      `queued -> syncing` on disk BEFORE its upload starts, and is removed from
 *      disk AFTER it succeeds. A crash in between therefore leaves a record of
 *      what was in flight instead of a queue that looks untouched.
 *   4. AN INTERRUPTED ITEM IS NOT RETRIED AUTOMATICALLY. See
 *      `INTERRUPTED_UPLOAD_MESSAGE`. Recovering it as a normal `queued` item
 *      would re-upload an audit that may already have been filed — and the API
 *      has no duplicate guard, so that creates a second evidence row rather than
 *      a rejection. Measured, not assumed: `EvidenceService.submitEvidence`
 *      creates a record unconditionally and only the task-state transition is
 *      conditional.
 *
 * WHAT IT CANNOT TELL YOU
 * -----------------------
 * That AsyncStorage works. `queueStorage.ts` is not imported here — it cannot
 * be, it calls a native module — so the suite proves the policy, not the storage
 * underneath it. Nothing in this file has been run on a device.
 *
 * AND WHAT IT STILL DOES NOT DO
 * -----------------------------
 * Automatic retry is triggered by RECONNECTION, not by a timer. There is no
 * background interval. An item that fails while the device is already online
 * waits for the next reconnection or for the worker to press sync. That is a
 * real limit, it is recorded in the plan's debt table, and the reason is that a
 * timer on a mobile client belongs to a component lifecycle — which lands with
 * the screen layer in 3.5.
 */

import { QueueItem, AuditMetadata } from '../types';

export type UploadHandler = (
  item: QueueItem,
) => Promise<{ photoUrl: string; submissionId: string }>;

/**
 * The seam between this policy and the platform.
 *
 * One key, one value: the whole queue as one JSON string. Deliberately not a
 * key-per-item store, because the queue is only ever read and written whole and
 * a partially-written set of keys is harder to reason about than one blob whose
 * write either landed or did not.
 */
export interface QueueStorage {
  read(): Promise<string | null>;
  write(serialized: string): Promise<void>;
}

/**
 * Storage that forgets everything when the process ends.
 *
 * The default, deliberately, and for the same reason as `MemorySecureStore`:
 * a build that never wires the native adapter still works exactly as the app did
 * before this file existed, and the suite can drive the whole policy without a
 * device.
 */
export class MemoryQueueStorage implements QueueStorage {
  private value: string | null = null;

  async read(): Promise<string | null> {
    return this.value;
  }

  async write(serialized: string): Promise<void> {
    this.value = serialized;
  }

  /** How many bytes are actually stored. For the size-limit checks in the suite. */
  get byteLength(): number {
    return this.value === null ? 0 : utf8Bytes(this.value);
  }
}

/** The key `queueStorage.ts` uses. Exported so the adapter and the suite agree. */
export const QUEUE_STORAGE_KEY = 'oneteam.offlineQueue.v1';

/** The plan's limit: 50 MB of queued audits on the device. */
export const MAX_QUEUE_BYTES = 50 * 1024 * 1024;

/**
 * How many times an item is retried without anybody asking.
 *
 * A cap rather than infinite retries, because a device that retries forever
 * against a failing endpoint burns battery and data for nothing. Reaching the
 * cap does NOT discard the item — it stops the automatic attempts and leaves it
 * visible with its last error, and a manual sync ignores the cap because a
 * person is standing there asking.
 */
export const MAX_RETRY_ATTEMPTS = 5;

/**
 * What an item left in `syncing` is told when the app comes back.
 *
 * The wording matters and is the whole reason this is a named constant. The
 * upload may have succeeded and the process died before the queue could record
 * it, so this item is NOT known to be unsent — and the API will accept a second
 * submission for the same task without complaint, producing two evidence rows
 * for one audit. So the item is marked failed with the retry count at its cap:
 * out of the automatic path, still sendable by hand, and honest about why.
 */
export const INTERRUPTED_UPLOAD_MESSAGE =
  'Tətbiq bu auditin göndərilməsi əsnasında bağlanıb. O, artıq qeydə alınmış ola bilər — ' +
  'təkrar göndərməzdən əvvəl yoxlayın. Avtomatik cəhd dayandırıldı.';

/** A queue failure, distinguishable from an upload failure by its code. */
export class QueueError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
  }
}

/** Why a drain did or did not do anything. `drained` means it tried. */
export type DrainReason =
  'drained' | 'offline' | 'busy' | 'nothing-pending' | 'no-handler' | 'storage-failed';

export interface DrainResult {
  syncedCount: number;
  failedCount: number;
  /** Items held back because they are past the automatic retry cap. */
  skippedCount: number;
  reason: DrainReason;
  /** Present only when `reason` is `storage-failed`. */
  error?: string;
}

/**
 * UTF-8 length, computed rather than assumed.
 *
 * `String.length` counts UTF-16 code units, so it under-counts every non-ASCII
 * character: the Azerbaijani in a store name or an error message is one unit and
 * two bytes. For a limit whose job is to protect the device's storage,
 * under-counting is the wrong direction. `TextEncoder` would do this, but it is
 * a runtime API this code cannot check from here, so the arithmetic is written
 * out — it is exact for well-formed strings and needs nothing.
 */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: the pair is four bytes, and the low surrogate is skipped.
      bytes += 4;
      index++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What `load()` found wrong with the stored payload, when it found anything. */
export interface QueueLoadReport {
  /** Items restored and usable. */
  restoredCount: number;
  /** Items discarded because they were not shaped like a QueueItem. */
  droppedCount: number;
  /** Items that were in flight when the app stopped, now held back. */
  interruptedCount: number;
  /** Set when the stored payload could not be parsed at all. */
  corruption: { length: number; sample: string } | null;
}

function looksLikeQueueItem(value: unknown): value is QueueItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<QueueItem>;
  return (
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.task_id === 'string' &&
    typeof item.store_id === 'string' &&
    typeof item.metadata === 'object' &&
    item.metadata !== null
  );
}

export class OfflineQueueManager {
  private queue: QueueItem[] = [];
  private isDeviceOnline: boolean = true;
  private isSyncing: boolean = false;
  private onQueueChangeListener?: (count: number) => void;

  private storage: QueueStorage = new MemoryQueueStorage();

  /**
   * Whether the in-memory queue is the whole truth.
   *
   * Starts true because the default storage is memory: an empty memory queue IS
   * empty, so there is nothing to be wrong about. `useStorage()` sets it false,
   * and it stays false until a read has actually happened — because from that
   * point on, answering "the queue is empty" without having read would be a
   * claim about items that are sitting on disk.
   */
  private loaded = true;
  private loadPromise: Promise<QueueLoadReport> | null = null;
  private lastLoadReport: QueueLoadReport | null = null;

  private uploadHandler: UploadHandler | null = null;

  /**
   * The drain that reconnection kicked off, so a caller can await it.
   *
   * `setOnlineStatus` cannot await it — it is called from a connectivity
   * listener that is not async — and a fire-and-forget promise that nobody can
   * observe is how `triggerAutoSync` stayed empty without anybody noticing.
   */
  private autoSyncPromise: Promise<DrainResult> | null = null;

  constructor(initialOnlineStatus: boolean = true) {
    this.isDeviceOnline = initialOnlineStatus;
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  setOnQueueChange(listener: (count: number) => void) {
    this.onQueueChangeListener = listener;
  }

  /**
   * Points the queue at a different backing store.
   *
   * Called once by the app entry with the AsyncStorage adapter. The queue is
   * NOT cleared and the load is NOT started here: the read is asynchronous, so
   * starting it and returning would leave a window in which the in-memory queue
   * looks empty while items sit on disk. `loaded` goes false instead, which
   * makes that window a refusal rather than a wrong answer, and the caller
   * closes it with `await load()`.
   */
  useStorage(storage: QueueStorage): void {
    this.storage = storage;
    this.loaded = false;
    this.loadPromise = null;
    this.lastLoadReport = null;
  }

  /**
   * The upload path a reconnection should use.
   *
   * Registered rather than hardcoded, because this file must not import the API
   * client: the queue is about durability and the client is about transport, and
   * a queue that knows how to upload cannot be tested without a server. Pass
   * `null` to unregister — the read-only tier of the harness does that, so a
   * reconnection in it cannot perform a write.
   */
  setUploadHandler(handler: UploadHandler | null): void {
    this.uploadHandler = handler;
  }

  hasUploadHandler(): boolean {
    return this.uploadHandler !== null;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /** Whether the in-memory queue can be trusted to be the whole queue. */
  isLoaded(): boolean {
    return this.loaded;
  }

  /** What the last successful load found. Null before any load. */
  getLoadReport(): QueueLoadReport | null {
    return this.lastLoadReport;
  }

  /**
   * Reads the queue out of storage. Idempotent, and safe to call twice.
   *
   * A failure is NOT cached — `loadPromise` is dropped in the catch — because a
   * transient storage error would otherwise pin the queue to "unloaded" for the
   * life of the process and every later call would report the first failure.
   * That is the same shape as `CredentialStore.deviceId()`.
   *
   * It does not throw on a corrupt payload. A payload that cannot be parsed
   * means audits are unrecoverable, which is worth reporting — but throwing here
   * would abort app startup over it, and the honest middle is to start empty,
   * keep a bounded sample of what was there, and let the caller say so.
   */
  async load(): Promise<QueueLoadReport> {
    if (this.loaded) {
      return (
        this.lastLoadReport ?? {
          restoredCount: this.queue.length,
          droppedCount: 0,
          interruptedCount: 0,
          corruption: null,
        }
      );
    }

    if (!this.loadPromise) {
      this.loadPromise = this.readFromStorage().catch((error) => {
        this.loadPromise = null;
        throw error;
      });
    }
    return this.loadPromise;
  }

  private async readFromStorage(): Promise<QueueLoadReport> {
    const serialized = await this.storage.read();
    const report = this.adoptSerialized(serialized);

    this.loaded = true;
    this.lastLoadReport = report;
    this.notifyChange();
    return report;
  }

  /**
   * Parses a stored payload into the live queue, recovering interrupted items.
   *
   * Separated from the read so the suite can drive it with a payload it built
   * itself, without a storage round trip in the way.
   */
  private adoptSerialized(serialized: string | null): QueueLoadReport {
    const report: QueueLoadReport = {
      restoredCount: 0,
      droppedCount: 0,
      interruptedCount: 0,
      corruption: null,
    };

    if (!serialized) {
      this.queue = [];
      return report;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      // A bounded sample, not the whole payload: a corrupt blob can be 50 MB and
      // keeping it in memory to be looked at would be its own problem.
      report.corruption = { length: serialized.length, sample: serialized.slice(0, 200) };
      this.queue = [];
      return report;
    }

    if (!Array.isArray(parsed)) {
      report.corruption = { length: serialized.length, sample: serialized.slice(0, 200) };
      this.queue = [];
      return report;
    }

    const restored: QueueItem[] = [];
    for (const entry of parsed) {
      if (!looksLikeQueueItem(entry)) {
        report.droppedCount++;
        continue;
      }
      if (entry.sync_status === 'syncing') {
        // Rule 4. Held back rather than retried: see INTERRUPTED_UPLOAD_MESSAGE.
        entry.sync_status = 'failed';
        entry.retry_count = Math.max(entry.retry_count ?? 0, MAX_RETRY_ATTEMPTS);
        entry.error_message = INTERRUPTED_UPLOAD_MESSAGE;
        report.interruptedCount++;
      }
      restored.push(entry);
    }

    this.queue = restored;
    report.restoredCount = restored.length;
    return report;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.load();
  }

  /** The one place a write reaches the platform. Awaited by every caller. */
  private async persist(): Promise<void> {
    await this.storage.write(JSON.stringify(this.queue));
  }

  private assertLoaded(operation: string): void {
    if (this.loaded) return;
    throw new QueueError(
      `Lokal növbə hələ yüklənməyib — ${operation} indi doğru cavab verə bilməz, ` +
        'çünki saxlancdaki auditlər görünmür. `await load()` çağırılmalıdır.',
      'QUEUE_NOT_LOADED',
    );
  }

  // -------------------------------------------------------------------------
  // Connectivity
  // -------------------------------------------------------------------------

  /**
   * Updates network connectivity state and, on a reconnection, drains.
   *
   * The drain is stored rather than awaited — see `autoSyncPromise` — and
   * `triggerAutoSync` catches everything, so a connectivity listener can never
   * produce an unhandled rejection.
   */
  setOnlineStatus(online: boolean) {
    const previous = this.isDeviceOnline;
    this.isDeviceOnline = online;
    if (!previous && online) {
      this.autoSyncPromise = this.triggerAutoSync();
    }
  }

  getOnlineStatus(): boolean {
    return this.isDeviceOnline;
  }

  /**
   * The drain that reconnection started, or null if none has been.
   *
   * `await service.autoSync` is how the suite proves reconnection actually
   * drains. Without it the assertion would have to call `processQueue` by hand,
   * and it would pass against a `triggerAutoSync` that did nothing — which is
   * exactly what the old one did.
   */
  get autoSync(): Promise<DrainResult> | null {
    return this.autoSyncPromise;
  }

  private async triggerAutoSync(): Promise<DrainResult> {
    if (!this.uploadHandler) {
      // Not a silent no-op any more. The old method returned `undefined` whether
      // it had a handler or not, which is how an empty body stayed in place.
      return {
        syncedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        reason: 'no-handler',
      };
    }

    try {
      return await this.processQueue(this.uploadHandler);
    } catch (error) {
      // A storage failure aborts the drain, and this is the one place it is
      // turned into a value. Reported rather than thrown: a connectivity
      // listener cannot handle a rejection, and an unhandled one is a crash.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`⚠️ [oneTeam Mobile] Avtomatik sinxronizasiya dayandı: ${detail}`);
      return {
        syncedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        reason: 'storage-failed',
        error: detail,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Queue contents
  // -------------------------------------------------------------------------

  /**
   * Enqueues an audit submission when offline or on poor connectivity.
   *
   * Persisted before it is returned, and it THROWS if the write did not land —
   * the item is rolled back out of memory first, so the caller never sees a
   * queue that claims to hold work it cannot produce after a restart. A caller
   * that swallows the throw is telling a worker their audit is safe when it is
   * not, which is why the message says plainly that it was not queued.
   */
  async enqueueSubmission(params: {
    taskId: string;
    storeId: string;
    photoUri: string;
    photoBase64?: string;
    metadata: AuditMetadata;
  }): Promise<QueueItem> {
    await this.ensureLoaded();

    const queueItem: QueueItem = {
      id: `queue-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      task_id: params.taskId,
      store_id: params.storeId,
      photo_uri: params.photoUri,
      photo_base64: params.photoBase64,
      metadata: params.metadata,
      created_at: new Date().toISOString(),
      retry_count: 0,
      sync_status: 'queued',
    };

    const next = [...this.queue, queueItem];
    // Serialized once: the same string is measured against the limit and then
    // written, so what was measured is exactly what is stored.
    const serialized = JSON.stringify(next);
    const projectedBytes = utf8Bytes(serialized);

    if (projectedBytes > MAX_QUEUE_BYTES) {
      // Rule 2: refuse, do not evict. The oldest item is somebody's audit.
      throw new QueueError(
        `Lokal növbə doludur (${formatMb(projectedBytes)} / ${formatMb(MAX_QUEUE_BYTES)}). ` +
          'Şəkil növbəyə salınmadı — əvvəlcə növbədəki auditləri göndərin və ya təmizləyin.',
        'QUEUE_FULL',
      );
    }

    this.queue = next;
    try {
      await this.storage.write(serialized);
    } catch (error) {
      this.queue = this.queue.filter((item) => item.id !== queueItem.id);
      this.notifyChange();
      const detail = error instanceof Error ? error.message : String(error);
      throw new QueueError(
        `Audit növbəyə yazıla bilmədi (${detail}). O, yaddaşda saxlanılmadı — ` +
          'tətbiq bağlansa itiriləcəkdi.',
        'QUEUE_WRITE_FAILED',
      );
    }

    this.notifyChange();
    return queueItem;
  }

  /**
   * Returns all items currently in the queue.
   *
   * Refuses rather than answering when a persistent store has been wired but not
   * yet read: an empty array there is not "nothing is queued", it is "nobody has
   * looked", and the two are indistinguishable to a caller that only sees `[]`.
   */
  getQueue(): QueueItem[] {
    this.assertLoaded('növbəni oxumaq');
    return [...this.queue];
  }

  getPendingCount(): number {
    this.assertLoaded('gözləyən sayı oxumaq');
    return this.pendingCount();
  }

  /** The unguarded count, for `notifyChange`, which runs during the load itself. */
  private pendingCount(): number {
    return this.queue.filter(
      (item) => item.sync_status === 'queued' || item.sync_status === 'failed',
    ).length;
  }

  // -------------------------------------------------------------------------
  // Draining
  // -------------------------------------------------------------------------

  /**
   * Uploads everything waiting in the offline queue, in order, one at a time.
   *
   * `manual` decides whether the retry cap applies. Automatic drains stop
   * retrying an item that has failed `MAX_RETRY_ATTEMPTS` times; a manual drain
   * ignores the cap, because a person pressing sync is new information and the
   * cap exists to stop the app retrying unattended, not to overrule the worker.
   *
   * Sequential rather than parallel, on purpose: these are multi-megabyte
   * images on a phone's uplink, and firing three at once on a weak connection
   * makes all three slower and more likely to time out.
   *
   * It THROWS if the queue cannot be written, and that is deliberate. If the
   * marker write fails the drain must stop — continuing would upload items whose
   * progress cannot be recorded, so a crash afterwards would re-upload them.
   * Callers that cannot handle a rejection (`triggerAutoSync`) turn it into a
   * value; callers that can, should.
   */
  async processQueue(
    uploadHandler: UploadHandler,
    options: { manual?: boolean } = {},
  ): Promise<DrainResult> {
    await this.ensureLoaded();

    if (!this.isDeviceOnline) {
      return { syncedCount: 0, failedCount: 0, skippedCount: 0, reason: 'offline' };
    }
    if (this.isSyncing) {
      return { syncedCount: 0, failedCount: 0, skippedCount: 0, reason: 'busy' };
    }

    const candidates = this.queue.filter(
      (item) => item.sync_status === 'queued' || item.sync_status === 'failed',
    );
    const pending = options.manual
      ? candidates
      : candidates.filter((item) => item.retry_count < MAX_RETRY_ATTEMPTS);

    const skippedCount = candidates.length - pending.length;

    if (pending.length === 0) {
      return {
        syncedCount: 0,
        failedCount: 0,
        skippedCount,
        reason: 'nothing-pending',
      };
    }

    this.isSyncing = true;
    let syncedCount = 0;
    let failedCount = 0;

    try {
      for (const item of pending) {
        // Rule 3: the marker is on disk BEFORE the upload starts, so a crash
        // during the upload leaves evidence of what was in flight.
        item.sync_status = 'syncing';
        await this.persist();

        // The upload is in its own try. A storage failure must not be mistaken
        // for an upload failure: marking an item failed because the queue could
        // not be written would schedule a second upload of something that has
        // already been filed.
        let uploadError: unknown = null;
        try {
          await uploadHandler(item);
        } catch (error) {
          uploadError = error;
        }

        if (uploadError === null) {
          item.sync_status = 'synced';
          this.queue = this.queue.filter((queued) => queued.id !== item.id);
          syncedCount++;
        } else {
          item.retry_count += 1;
          item.sync_status = 'failed';
          item.error_message =
            uploadError instanceof Error ? uploadError.message : String(uploadError);
          failedCount++;
        }

        await this.persist();
      }
    } finally {
      this.isSyncing = false;
      this.notifyChange();
    }

    return { syncedCount, failedCount, skippedCount, reason: 'drained' };
  }

  /**
   * Removes everything from the queue, on disk as well as in memory.
   *
   * Async because it has to be: clearing only the memory copy would bring every
   * item back on the next launch, which is the opposite of what "start over"
   * means. Returns how many were removed, so a caller can tell that it did
   * something rather than that it looked like it did.
   */
  async clearQueue(): Promise<number> {
    await this.ensureLoaded();
    const cleared = this.queue.length;
    this.queue = [];
    await this.persist();
    this.notifyChange();
    return cleared;
  }

  private notifyChange() {
    if (this.onQueueChangeListener) {
      this.onQueueChangeListener(this.pendingCount());
    }
  }
}

export const offlineQueueService = new OfflineQueueManager();
