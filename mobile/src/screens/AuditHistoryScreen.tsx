import { MobileSubmission, QueueItem } from '../types';
import { mobileApi } from '../services/portalApi';
import { offlineQueueService } from '../services/offlineQueue';

export interface AuditHistoryViewData {
  submissions: MobileSubmission[];
  queuedItems: QueueItem[];
  pendingSyncCount: number;
}

export class AuditHistoryController {
  /**
   * The audits filed from this device at this store, plus anything still queued.
   *
   * The queue is device-local and the history comes from the API, so the two are
   * merged here rather than by the server: a queued audit does not exist on the
   * server yet, and hiding it until it uploads would leave a field worker unable
   * to see their own unsent work.
   */
  async getAuditHistory(storeId: string): Promise<AuditHistoryViewData> {
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
   */
  async triggerManualSync(): Promise<{ syncedCount: number; failedCount: number }> {
    return offlineQueueService.processQueue(async (item) => {
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
      });

      return { photoUrl, submissionId: submission.id };
    });
  }
}
