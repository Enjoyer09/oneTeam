import {
  MobileTask,
  MobileStore,
  GPSCoordinates,
  AuditMetadata,
  MobileSubmission,
  QueueItem,
} from '../types';
import { stampAuditMetadata, assertLiveCameraCapture } from '../components/SmartCameraOverlay';
import { mobileSupabase } from '../services/supabaseMobile';
import { offlineQueueService } from '../services/offlineQueue';

export interface CameraScreenState {
  ghostOverlayActive: boolean;
  ghostOpacity: number; // 0.0 to 1.0
  gridGuideActive: boolean;
  isCapturing: boolean;
  lastCapturedPhotoUri: string | null;
}

export class CameraAuditController {
  private task: MobileTask;
  private store: MobileStore;
  private state: CameraScreenState = {
    ghostOverlayActive: true,
    ghostOpacity: 0.45,
    gridGuideActive: true,
    isCapturing: false,
    lastCapturedPhotoUri: null,
  };

  constructor(task: MobileTask, store: MobileStore) {
    this.task = task;
    this.store = store;
  }

  getState(): CameraScreenState {
    return { ...this.state };
  }

  setGhostOpacity(opacity: number) {
    this.state.ghostOpacity = Math.max(0, Math.min(1, opacity));
  }

  toggleGrid() {
    this.state.gridGuideActive = !this.state.gridGuideActive;
  }

  toggleGhost() {
    this.state.ghostOverlayActive = !this.state.ghostOverlayActive;
  }

  /**
   * Captures live photo from camera sensor (Gallery selection strictly prohibited)
   */
  async captureLiveAudit(params: {
    source: 'camera' | 'gallery';
    userGPS: GPSCoordinates;
  }): Promise<{
    photoUri: string;
    metadata: AuditMetadata;
  }> {
    // 1. Anti-fraud assertion: must be live camera
    assertLiveCameraCapture(params.source);

    this.state.isCapturing = true;

    // Simulate in-app camera hardware capture
    const photoUri = `file:///var/mobile/Containers/Data/Application/oneTeam/tmp/shelf_${Date.now()}.jpg`;
    this.state.lastCapturedPhotoUri = photoUri;

    // 2. Stamp rich telemetry metadata
    const metadata = stampAuditMetadata({
      userGPS: params.userGPS,
      storeGPS: {
        latitude: this.store.latitude,
        longitude: this.store.longitude,
      },
      ghostOverlayUsed: this.state.ghostOverlayActive,
    });

    this.state.isCapturing = false;

    return { photoUri, metadata };
  }

  /**
   * Submits or enqueues the captured audit photo
   */
  async processAuditSubmission(params: {
    photoUri: string;
    metadata: AuditMetadata;
  }): Promise<{
    status: 'uploaded' | 'queued_offline';
    submission?: MobileSubmission;
    queueItem?: QueueItem;
  }> {
    const isOnline = offlineQueueService.getOnlineStatus();

    if (!isOnline) {
      // Offline mode (basement store): queue locally
      const queueItem = await offlineQueueService.enqueueSubmission({
        taskId: this.task.id,
        storeId: this.store.id,
        photoUri: params.photoUri,
        metadata: params.metadata,
      });

      return { status: 'queued_offline', queueItem };
    }

    // Online mode: direct Supabase upload
    const photoUrl = await mobileSupabase.uploadPhotoToStorage(
      params.photoUri,
      this.store.id,
      this.task.id
    );

    const submission = await mobileSupabase.submitAudit({
      taskId: this.task.id,
      storeId: this.store.id,
      photoUrl,
      metadata: params.metadata,
    });

    return { status: 'uploaded', submission };
  }
}
