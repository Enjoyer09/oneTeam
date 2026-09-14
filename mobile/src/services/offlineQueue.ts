import { QueueItem, AuditMetadata } from '../types';

export type UploadHandler = (item: QueueItem) => Promise<{ photoUrl: string; submissionId: string }>;

export class OfflineQueueManager {
  private queue: QueueItem[] = [];
  private isDeviceOnline: boolean = true;
  private isSyncing: boolean = false;
  private onQueueChangeListener?: (count: number) => void;

  constructor(initialOnlineStatus: boolean = true) {
    this.isDeviceOnline = initialOnlineStatus;
  }

  /**
   * Set listener for queue updates
   */
  setOnQueueChange(listener: (count: number) => void) {
    this.onQueueChangeListener = listener;
  }

  /**
   * Updates network connectivity state
   */
  setOnlineStatus(online: boolean) {
    const prev = this.isDeviceOnline;
    this.isDeviceOnline = online;
    if (!prev && online) {
      // Reconnected! Auto-trigger queue sync
      this.triggerAutoSync();
    }
  }

  getOnlineStatus(): boolean {
    return this.isDeviceOnline;
  }

  /**
   * Enqueues an audit submission when offline or poor connectivity
   */
  async enqueueSubmission(params: {
    taskId: string;
    storeId: string;
    photoUri: string;
    photoBase64?: string;
    metadata: AuditMetadata;
  }): Promise<QueueItem> {
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

    this.queue.push(queueItem);
    this.notifyChange();

    return queueItem;
  }

  /**
   * Returns all items currently in the queue
   */
  getQueue(): QueueItem[] {
    return [...this.queue];
  }

  getPendingCount(): number {
    return this.queue.filter((q) => q.sync_status === 'queued' || q.sync_status === 'failed').length;
  }

  /**
   * Processes all queued items and uploads them to Supabase
   */
  async processQueue(
    uploadHandler: UploadHandler
  ): Promise<{ syncedCount: number; failedCount: number }> {
    if (!this.isDeviceOnline || this.isSyncing) {
      return { syncedCount: 0, failedCount: 0 };
    }

    this.isSyncing = true;
    let syncedCount = 0;
    let failedCount = 0;

    const pendingItems = this.queue.filter(
      (item) => item.sync_status === 'queued' || item.sync_status === 'failed'
    );

    for (const item of pendingItems) {
      item.sync_status = 'syncing';
      try {
        await uploadHandler(item);
        item.sync_status = 'synced';
        syncedCount++;
        // Remove synced item from queue
        this.queue = this.queue.filter((q) => q.id !== item.id);
      } catch (err: any) {
        item.retry_count += 1;
        item.sync_status = 'failed';
        item.error_message = err?.message || 'Upload error';
        failedCount++;
      }
    }

    this.isSyncing = false;
    this.notifyChange();

    return { syncedCount, failedCount };
  }

  private triggerAutoSync() {
    // When reconnected, automatic sync is initiated
  }

  private notifyChange() {
    if (this.onQueueChangeListener) {
      this.onQueueChangeListener(this.getPendingCount());
    }
  }

  clearQueue() {
    this.queue = [];
    this.notifyChange();
  }
}

export const offlineQueueService = new OfflineQueueManager();
