import {
  MobileTask,
  MobileStore,
  GPSCoordinates,
  AuditMetadata,
  MobileSubmission,
  QueueItem,
} from '../types';
import { stampAuditMetadata, assertLiveCameraCapture } from '../components/SmartCameraOverlay';
import { mobileApi, MobileApiError, newIdempotencyKey } from '../services/portalApi';
import { offlineQueueService } from '../services/offlineQueue';
import type { PhotoQualityAssessment } from '../utils/photoQuality';

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
  /** Client-side key for idempotent retry of this capture's submission. */
  idempotencyKey: string;
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
   * new one. The capture is real too, since 2026-09-20: the screen calls
   * `takePictureAsync({ base64: true })` and hands the bytes in here, and a
   * capture that returns no bytes is refused rather than filed as a placeholder.
   *
   * The GPS stamp is real in the sense that it is exactly `params.userGPS` — but
   * that is only worth anything if the caller's fix is real, and for one commit
   * it was not. `Root.tsx` passed a hardcoded `{40.4093, 49.8671}` (the old fake
   * login's coordinates) into this parameter, so every audit carried a constant
   * position while this method dutifully stamped it. A function that honestly
   * records whatever it is given is still a source of false evidence if its
   * caller lies; the fix belongs at the call site, and that is where it was made.
   *
   * This is the position verified at sign-in, not a fresh fix taken at the
   * moment of capture. That distinction is real and is the next thing to close.
   */
  async captureLiveAudit(params: {
    source: 'camera' | 'gallery';
    userGPS: GPSCoordinates;
    /**
     * Whether `userGPS` is a fresh fix taken at this capture, or the sign-in
     * fallback. Forwarded to the stamper so the distinction the review banner
     * shows the worker is also written into the durable audit record, the
     * offline queue, and the server submission — not left to vanish with the UI.
     */
    isFresh?: boolean;
    /** Real capture bytes, when the platform camera provided them. */
    base64?: string;
    /**
     * Barcodes read off the shelf during this capture. De-duplicated by the
     * stamper, in the order they were read. The list may be absent when the
     * worker did not scan anything; the stamper preserves that distinction.
     */
    scannedBarcodes?: readonly string[];
    /**
     * The capture-time quality verdict, from the EXIF the platform returned
     * with the bytes. Optional because a caller that did not ask for EXIF has
     * nothing to pass — and the stamper keeps "not judged" distinct from
     * "judged and fine".
     */
    photoQuality?: PhotoQualityAssessment;
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
        'STORE_HAS_NO_COORDINATES',
      );
    }

    const metadata = stampAuditMetadata({
      userGPS: params.userGPS,
      storeGPS: {
        latitude: this.store.latitude,
        longitude: this.store.longitude,
      },
      // THE OVERLAY IS ONLY "USED" IF THERE WAS SOMETHING TO OVERLAY.
      //
      // This used to be `this.state.ghostOverlayActive` on its own, which meant
      // every audit recorded `ghost_overlay_used: true` as soon as the toggle
      // defaulted on — while the screen rendered a badge reading "👻 Ghost
      // overlay aktiv" and no reference image at all. The audit trail therefore
      // asserted a planogram comparison that never happened, on every single
      // submission. A supervisor reading the record could not tell those apart
      // from the real thing, which is what makes it worth fixing rather than
      // documenting: the field is only useful if `true` means something.
      ghostOverlayUsed: this.state.ghostOverlayActive && this.task.reference_image_url !== null,
      // Fresh-fix-at-capture vs sign-in fallback, forwarded as the screen
      // resolved it. The stamper writes it into the metadata only when present,
      // so a caller that never resolved a position does not assert one.
      locationIsFresh: params.isFresh,
      // The barcode list is forwarded as the worker built it; the stamper is
      // the one place that decides whether to keep it and how to de-duplicate
      // it, so two call sites cannot disagree on what "scanned" means.
      scannedBarcodes: params.scannedBarcodes,
      // The verdict travels with the photo. Note that `flagged` does not stop
      // the submission here — the screen asks the worker to confirm, and this
      // method records whatever it was told. A controller that silently
      // dropped a flagged capture would be a controller that loses evidence.
      photoQuality: params.photoQuality,
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
      idempotencyKey: newIdempotencyKey(),
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
    idempotencyKey?: string;
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

    // A real capture goes straight to the bucket via a presigned URL and this
    // gets back the `publicUrl`; with no bucket (or a failed PUT) it falls back
    // to a `data:` URL. When there is no capture at all it throws rather than
    // inventing one — see mobileApi.uploadPhoto. The `fileName` directory
    // becomes the upload scope.
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
      idempotencyKey: params.idempotencyKey,
    });

    return { status: 'uploaded', submission };
  }
}

// ===========================================================================
// Where was the photo actually taken?
// ===========================================================================
//
// The position stamped into the evidence used to be a constant, and the fix for
// that made it the position verified at SIGN-IN. Sign-in was the right place to
// start — it is the only position the geofence ever checked — but it is not the
// same question as "where was this photo taken?". A worker can sign in at the
// store and photograph a shelf somewhere else; the geofence would pass and the
// evidence would still be wrong, because it records the moment of sign-in.
//
// So the capture asks for its own fix. What it does when the platform cannot
// answer is the part that needs a decision, and the decision here is:
//
//   USE THE REAL SIGN-IN FIX, AND SAY THAT YOU DID.
//
// Not "use a constant", and not "refuse". Refusing would strand a worker in a
// basement store with no signal; industry practice is explicit that capture
// continues without a signal and the evidence is queued. The sign-in fix is a
// real position the geofence already passed — it is weaker than a fresh fix, and
// `isFresh: false` says so out loud rather than letting the two look identical.
//
// WHAT THE METADATA NOW RECORDS: `location_is_fresh`. `AuditMetadata` is a
// mobile-local shape — the server stores the submission's `metadata` as an
// opaque object, so adding a field is additive and needs no API change. The
// freshness verdict therefore travels with the evidence into the offline queue
// and up to the server, instead of living only in the capture-time banner.

export interface CapturePosition {
  gps: GPSCoordinates;
  /** True when the platform answered at the moment of capture. */
  isFresh: boolean;
}

export function resolveCapturePosition(
  signIn: GPSCoordinates,
  fresh: GPSCoordinates | null,
): CapturePosition {
  if (fresh === null) {
    return { gps: signIn, isFresh: false };
  }
  return { gps: fresh, isFresh: true };
}
