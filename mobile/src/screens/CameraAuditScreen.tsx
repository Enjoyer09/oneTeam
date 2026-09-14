import {
  MobileTask,
  MobileStore,
  GPSCoordinates,
  AuditMetadata,
  MobileSubmission,
  QueueItem,
} from '../types';
import { stampAuditMetadata, assertLiveCameraCapture } from '../components/SmartCameraOverlay';
import { mobileApi, MobileApiError } from '../services/portalApi';
import { offlineQueueService } from '../services/offlineQueue';

export interface CameraScreenState {
  ghostOverlayActive: boolean;
  ghostOpacity: number; // 0.0 to 1.0
  gridGuideActive: boolean;
  isCapturing: boolean;
  lastCapturedPhotoUri: string | null;
}

/**
 * The result of a capture attempt.
 *
 * `base64` is the image itself. It is optional because this harness has no
 * native camera module, and `simulated` says so explicitly rather than leaving
 * the caller to guess from the URI. A shipping build fills `base64` from the
 * platform camera and leaves `simulated` false.
 */
export interface CapturedPhoto {
  photoUri: string;
  metadata: AuditMetadata;
  base64?: string;
  simulated: boolean;
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
   * Captures a live photo from the camera sensor (gallery selection strictly
   * prohibited).
   *
   * WHAT IS REAL AND WHAT IS NOT
   * ----------------------------
   * The anti-gallery rule is real: `assertLiveCameraCapture` refuses a gallery
   * source, and it is the control that stops an old photo being passed off as a
   * new one. The GPS stamp is real, because it comes from the caller's fix.
   *
   * The capture itself is simulated. There is no native camera module in this
   * harness, so `photoUri` is a plausible-looking path to a file that does not
   * exist and `base64` is absent. That is stated in the return value rather than
   * hidden, so the submission records `photo_origin: 'placeholder'` instead of
   * filing a fabricated image as evidence.
   */
  async captureLiveAudit(params: {
    source: 'camera' | 'gallery';
    userGPS: GPSCoordinates;
    /** Real capture bytes, when the platform camera provided them. */
    base64?: string;
  }): Promise<CapturedPhoto> {
    // 1. Anti-fraud assertion: must be live camera
    assertLiveCameraCapture(params.source);

    this.state.isCapturing = true;

    // 2. Stamp rich telemetry metadata.
    //
    // The store's coordinates are guaranteed non-null: the login screen refuses a
    // store without them, because a geofence comparison needs two real positions.
    // The guard is here as well so this cannot silently compare against 0,0 if a
    // caller constructs the controller another way.
    if (this.store.latitude === null || this.store.longitude === null) {
      this.state.isCapturing = false;
      throw new MobileApiError(
        `"${this.store.name}" mağazasının koordinatları yoxdur — geolokasiya yoxlaması aparıla bilməz.`,
        400,
        'STORE_HAS_NO_COORDINATES'
      );
    }

    const metadata = stampAuditMetadata({
      userGPS: params.userGPS,
      storeGPS: {
        latitude: this.store.latitude,
        longitude: this.store.longitude,
      },
      ghostOverlayUsed: this.state.ghostOverlayActive,
    });

    const photoUri =
      params.base64 !== undefined
        ? `camera://live/${this.store.id}/${this.task.id}/${Date.now()}.jpg`
        : `file:///var/mobile/Containers/Data/Application/oneTeam/tmp/shelf_${Date.now()}.jpg`;

    this.state.lastCapturedPhotoUri = photoUri;
    this.state.isCapturing = false;

    return {
      photoUri,
      metadata,
      base64: params.base64,
      simulated: params.base64 === undefined,
    };
  }

  /**
   * Submits or enqueues the captured audit photo.
   *
   * The acknowledgement is not optional. The lifecycle only allows a review from
   * SUBMITTED, and a submission only advances a task that is already
   * ACKNOWLEDGED — so without it the photo would land on a task no supervisor
   * could ever approve. The chat channel does the same thing when the task is
   * opened; the mobile client does it here because opening a task in this app is
   * not an event the server sees.
   *
   * A failure is logged and the flow continues: the worker can still send the
   * photo, and a supervisor can move the task on by hand.
   */
  async processAuditSubmission(params: {
    photoUri: string;
    metadata: AuditMetadata;
    base64?: string;
  }): Promise<{
    status: 'uploaded' | 'queued_offline';
    submission?: MobileSubmission;
    queueItem?: QueueItem;
  }> {
    const isOnline = offlineQueueService.getOnlineStatus();

    if (!isOnline) {
      // Offline mode (basement store): queue locally. The image bytes are queued
      // alongside the path, because the file may be gone by the time the queue is
      // drained — see the note on QueueItem.photo_base64.
      const queueItem = await offlineQueueService.enqueueSubmission({
        taskId: this.task.id,
        storeId: this.store.id,
        photoUri: params.photoUri,
        photoBase64: params.base64,
        metadata: params.metadata,
      });

      return { status: 'queued_offline', queueItem };
    }

    try {
      const ack = await mobileApi.acknowledgeTask(this.task.id);
      if (ack.advanced) {
        console.log(`[oneTeam Mobile] Task ${this.task.id} -> ${ack.currentState} (acknowledged)`);
      }
    } catch (error) {
      const detail = error instanceof MobileApiError ? error.message : String(error);
      console.error(`[oneTeam Mobile] Acknowledge failed for ${this.task.id}:`, detail);
    }

    // No object store yet, so this returns a `data:` URL. When there is none to
    // send it throws rather than inventing one — see mobileApi.uploadPhoto.
    const { photoUrl, origin } = await mobileApi.uploadPhoto({
      base64: params.base64,
      fileName: `audits/${this.store.id}/${this.task.id}_${Date.now()}.jpg`,
      placeholder: params.base64 === undefined,
    });

    const submission = await mobileApi.submitAudit({
      taskId: this.task.id,
      storeId: this.store.id,
      photoUrl,
      photoOrigin: origin,
      gps: params.metadata.gps,
      distanceFromStoreMeters: params.metadata.distance_from_store_meters,
      metadata: params.metadata,
    });

    return { status: 'uploaded', submission };
  }
}
