import { MobileSubmission, QueueItem } from '../types';
import { mobileApi } from '../services/portalApi';
import { offlineQueueService, UploadHandler } from '../services/offlineQueue';

export interface AuditHistoryViewData {
  submissions: MobileSubmission[];
  queuedItems: QueueItem[];
  pendingSyncCount: number;
}

/**
 * The one way a queued audit becomes a filed one.
 *
 * Two things happen per item, in this order, and both are required:
 *
 *   1. the task is acknowledged — the lifecycle only lets a submission advance
 *      an ACKNOWLEDGED task, and a queued audit is uploaded long after the
 *      worker opened it, so nothing else has done this;
 *   2. the photo is uploaded and filed.
 *
 * An item whose image bytes are no longer available fails here with
 * `CAPTURE_NOT_AVAILABLE` and stays in the queue with that message attached.
 * That is deliberate: the alternative is to file a placeholder image as if it
 * were the audit the worker took, which would put fabricated evidence in front
 * of a supervisor.
 *
 * It is a module-level function rather than a closure inside
 * `triggerManualSync` because it now has TWO callers. Plan item 3.3 made
 * `triggerAutoSync` real, and a reconnection has to drain the queue with the
 * same rules a manual sync uses — including the acknowledgement, which is easy
 * to forget when the path is written a second time.
 */
const uploadQueuedAudit: UploadHandler = async (item) => {
  await mobileApi.acknowledgeTask(item.task_id);

  const { photoUrl, origin } = await mobileApi.uploadPhoto({
    base64: item.photo_base64,
    fileName: `audits/${item.store_id}/${item.task_id}_${Date.now()}.jpg`,
  });

  const submission = await mobileApi.submitAudit({
    taskId: item.task_id,
    storeId: item.store_id,
    photoUrl,
    photoOrigin: origin,
    gps: item.metadata.gps,
    distanceFromStoreMeters: item.metadata.distance_from_store_meters,
    metadata: item.metadata,
    // The idempotency key for this drain.
    //
    // A drain that crashes halfway through or times out on the wire may have
    // already filed this audit with the API. When the worker taps sync again,
    // or when the reconnection listener fires, this key makes the server
    // return the evidence it already created instead of filing a duplicate.
    //
    // Prefer the capture's own key when the item carries one: an item queued as
    // a fallback after an online submit failed must file under the SAME key that
    // online attempt sent, or a POST that actually landed would be duplicated
    // here. A plain offline capture has no such key, so the item id stands in.
    idempotencyKey: item.idempotency_key ?? item.id,
  });

  return { photoUrl, submissionId: submission.id };
};

export class AuditHistoryController {
  /**
   * Registers the upload path with the queue, once, at construction.
   *
   * Registered here rather than in a screen because a reconnection can happen
   * before any screen has been opened — the worker comes out of the basement and
   * the app is on the login screen — and `triggerAutoSync` needs a handler to
   * exist at that moment. A registration that only happened when the history
   * screen mounted would mean the queue drains only if the worker happened to be
   * looking at the right page, which is the same class of bug as the empty
   * `triggerAutoSync` this replaced.
   *
   * The coordinator constructs this controller at module load (`mobileApp`), so
   * in a shipping build the handler is registered before the first render.
   */
  constructor() {
    offlineQueueService.setUploadHandler(uploadQueuedAudit);
  }

  /**
   * The audits filed from this device at this store, plus anything still queued.
   *
   * The queue is device-local and the history comes from the API, so the two are
   * merged here rather than by the server: a queued audit does not exist on the
   * server yet, and hiding it until it uploads would leave a field worker unable
   * to see their own unsent work.
   *
   * `load()` before reading. On a device the queue is on disk, and reading the
   * in-memory array without having read it first would show a worker an empty
   * list while their audits sit in the container — the precise failure this
   * screen exists to prevent.
   */
  async getAuditHistory(storeId: string): Promise<AuditHistoryViewData> {
    await offlineQueueService.load();

    const submissions = await mobileApi.getSubmissionsForStore(storeId);
    const queuedItems = offlineQueueService.getQueue().filter((q) => q.store_id === storeId);

    return {
      submissions,
      queuedItems,
      pendingSyncCount: queuedItems.length,
    };
  }

  /**
   * Uploads everything waiting in the offline queue.
   *
   * `manual: true` — the retry cap is waived. Automatic drains stop retrying an
   * item that has failed `MAX_RETRY_ATTEMPTS` times so an unattended phone does
   * not hammer a failing endpoint; a worker pressing sync is new information,
   * and the cap is not there to overrule them.
   */
  async triggerManualSync() {
    return offlineQueueService.processQueue(uploadQueuedAudit, { manual: true });
  }
}
