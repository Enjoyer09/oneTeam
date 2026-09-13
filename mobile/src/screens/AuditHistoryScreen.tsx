import { MobileSubmission, QueueItem } from '../types';
import { mobileSupabase } from '../services/supabaseMobile';
import { offlineQueueService } from '../services/offlineQueue';

export interface AuditHistoryViewData {
  submissions: MobileSubmission[];
  queuedItems: QueueItem[];
  pendingSyncCount: number;
}

export class AuditHistoryController {
  async getAuditHistory(storeId: string): Promise<AuditHistoryViewData> {
    const submissions = await mobileSupabase.getSubmissionsForStore(storeId);
    const queuedItems = offlineQueueService.getQueue().filter((q) => q.store_id === storeId);

    return {
      submissions,
      queuedItems,
      pendingSyncCount: queuedItems.length,
    };
  }

  async triggerManualSync(): Promise<{ syncedCount: number; failedCount: number }> {
    return offlineQueueService.processQueue(async (item) => {
      const photoUrl = await mobileSupabase.uploadPhotoToStorage(
        item.photo_uri,
        item.store_id,
        item.task_id
      );
      const sub = await mobileSupabase.submitAudit({
        taskId: item.task_id,
        storeId: item.store_id,
        photoUrl,
        metadata: item.metadata,
      });
      return { photoUrl, submissionId: sub.id };
    });
  }
}
