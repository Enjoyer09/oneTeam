/**
 * oneTeam mobile — Camera Audit screen (React Native UI)
 * ============================================================================
 *
 * WHAT THIS IS
 * ------------
 * The screen where the field worker captures the shelf photo: a live camera
 * preview, the ghost overlay toggle, the grid guide toggle, and the shutter.
 *
 * After capture, the photo is either uploaded immediately (online) or queued
 * for later (offline). The screen then returns to the task list.
 *
 * THE PREVIEW IS A REAL CAMERA, AND THAT IS THE WHOLE POINT
 * ---------------------------------------------------------
 * Until 2026-09-20 this screen drew a dark rectangle with a camera glyph in it
 * and a comment saying `expo-camera` "is not installed yet". It was installed —
 * declared in `package.json`, listed as a plugin in `app.json`, and compiled
 * into the app (`ios/Podfile.lock` lists ExpoCamera 57.0.5). The comment was
 * simply wrong, and it was load-bearing: it is why a photo-audit product could
 * be demonstrated without taking a photo.
 *
 * The capture now goes through `takePictureAsync({ base64: true })`, and the
 * bytes go to `captureLiveAudit`, which is what makes `simulated` false. The
 * controller already knew how to receive them; nothing below invents a photo,
 * and a capture that returns no bytes is reported as a failure rather than
 * quietly becoming a placeholder.
 *
 * THE GHOST OVERLAY WAS THE SAME KIND OF FAKE, ONE LAYER DOWN
 * -----------------------------------------------------------
 * The toggle was real, the badge was real, and the metadata was real — every
 * audit recorded `ghost_overlay_used: true` — but `task.reference_image_url`
 * was never rendered. The planogram reference, which is the entire reason a
 * "smart camera" exists, was never on screen. So the audit trail asserted a
 * comparison the worker had not been offered, on every submission.
 *
 * Both halves are fixed: the reference image is drawn over the preview at the
 * controller's opacity, and `ghost_overlay_used` is now false unless the task
 * actually carries a reference to overlay.
 *
 * WHY THIS IS A SEPARATE FILE
 * ---------------------------
 * `CameraAuditScreen.tsx` holds `CameraAuditController`, a plain class with no
 * React in it. Keeping the UI separate means the controller stays importable
 * from tests without pulling in `react-native`.
 */

import { useState, useCallback, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  Linking,
} from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Location from 'expo-location';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  CameraAuditController,
  resolveCapturePosition,
  type CapturedPhoto,
} from './CameraAuditScreen';
import {
  assessPhotoQuality,
  photoQualityStatus,
  type PhotoQualityAssessment,
} from '../utils/photoQuality';
import type { MobileTask, MobileStore, GPSCoordinates } from '../types';
import type { ChecklistAnswer } from './TaskDetailScreen';

export interface CameraAuditScreenProps {
  task: MobileTask;
  store: MobileStore;
  userGPS: GPSCoordinates;
  checklistAnswers: ChecklistAnswer[];
  onComplete: () => void;
  onCancel: () => void;
}

/**
 * Zoom steps as a fraction of the device's maximum (the `expo-camera` `zoom`
 * prop). Five steps is enough to frame a shelf without turning the control into
 * a slider the worker has to fiddle with standing in an aisle.
 */
const ZOOM_STEPS = [0, 0.25, 0.5, 0.75, 1] as const;

/**
 * The quality heuristic's reason codes, in the worker's language.
 *
 * Kept here and not in `photoQuality.ts` because that module produces codes
 * for the audit trail, and the audit trail is read by supervisors and machines
 * — a code that changes with the UI's wording would break both. This map is
 * the presentation layer, and the fallback is deliberate: an unknown code
 * shows itself rather than being swallowed, so a new rule cannot ship as a
 * blank warning.
 */
const QUALITY_REASON_TEXT: Record<string, string> = {
  too_dark: 'şəkil çox qaranlıqdır',
  overexposed: 'şəkil parıltılıdır (işıq həddindən artıqdır)',
  high_iso: 'işıq azdır — şəkil dənəli çıxıb',
  slow_shutter: 'çəkiliş sürəti yavaşdır — şəkil bulanıq ola bilər',
  no_exif: 'kamera şəkil haqqında məlumat vermədi',
};

function describeQuality(assessment: PhotoQualityAssessment): string {
  return assessment.reasons.map((r) => QUALITY_REASON_TEXT[r] ?? r).join(' · ');
}

export function CameraAuditScreenUI({
  task,
  store,
  userGPS,
  checklistAnswers,
  onComplete,
  onCancel,
}: CameraAuditScreenProps) {
  const insets = useSafeAreaInsets();
  const [controller] = useState(() => new CameraAuditController(task, store));
  const [state, setState] = useState(controller.getState());
  const [captured, setCaptured] = useState<CapturedPhoto | null>(null);
  // The file the platform wrote, kept separately from `captured.photoUri`. The
  // controller builds a `camera://live/...` identifier to say "these are real
  // bytes from the sensor", and that is not a path `Image` can open — so the
  // review screen needs the uri the camera actually returned.
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string | null>(null);

  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();

  // --- Camera hardware -------------------------------------------------------
  // A shelf in a small general-trade outlet is photographed at arm's length in
  // whatever light the shop has, which is often one bulb. Torch and zoom are not
  // decorations here: without them the worker cannot frame the shelf or read it,
  // and the photo is unusable however honest the rest of the pipeline is. Both
  // are real `expo-camera` props on the module already compiled into this app.
  const [torchOn, setTorchOn] = useState(false);

  // `zoom` is a FRACTION OF THE DEVICE'S MAXIMUM, not a multiplier: 0 means not
  // zoomed and 1 means maximum. Labelling it "0.25x" would therefore be a lie in
  // the other direction — it looks like a 4x zoom-out. The steps are held as an
  // index so the value stays one of a known set and the label can be honest.
  const [zoomStep, setZoomStep] = useState(0);
  const zoom = ZOOM_STEPS[zoomStep] ?? 0;

  // Whether the stamped position came from the moment of capture or from
  // sign-in. Shown to the worker, because the two are not the same claim.
  const [positionIsFresh, setPositionIsFresh] = useState(false);

  // The list of barcodes decoded by `expo-camera` while the preview was live.
  // Held in component state because the controller is plain and the scanner
  // fires continuously — the worker's reading of the shelf is an accumulating
  // signal, not a single one-shot value at the shutter.
  //
  // The list is de-duplicated in `handleBarcodeScanned` (so the same shelf
  // product is never counted twice) and forwarded to `captureLiveAudit` at the
  // moment of capture. `stampAuditMetadata` is the one place that decides what
  // to do with an empty list, so two callers cannot disagree on what "scanned"
  // means.
  const [scannedBarcodes, setScannedBarcodes] = useState<string[]>([]);

  // What the capture-time quality heuristic made of the photo, or null when no
  // capture has happened yet. `no_signal` is a real outcome and is displayed as
  // such — see the review screen — because telling a worker their photo is
  // "fine" when nobody could judge it is the same class of lie the rest of this
  // screen exists to prevent.
  const [quality, setQuality] = useState<PhotoQualityAssessment | null>(null);

  /**
   * Asks the platform where the device is RIGHT NOW, bounded in time.
   *
   * The timeout is not a nicety. `getCurrentPositionAsync` has no timeout of its
   * own, so on a device that cannot fix — indoors, no signal, location services
   * off — this would hang the shutter indefinitely and the worker would stand
   * there holding the phone. Racing it means the worst case is a known delay
   * followed by an honest fallback.
   */
  const acquireFreshFix = useCallback(async (): Promise<GPSCoordinates | null> => {
    try {
      const granted = await Location.requestForegroundPermissionsAsync();
      if (!granted.granted) return null;

      const position = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), 5000);
        }),
      ]);

      if (position === null) return null;

      return {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy:
          typeof position.coords.accuracy === 'number' ? position.coords.accuracy : undefined,
        // The platform's mock-location flag (Android). Forwarded so a spoofed fix
        // can be flagged on the submission; `undefined` on iOS, where it is not
        // exposed.
        mocked: typeof position.mocked === 'boolean' ? position.mocked : undefined,
      };
    } catch {
      // A failure to fix is a state, not an error to surface: the caller falls
      // back to the sign-in position and reports that it did.
      return null;
    }
  }, []);

  const refreshState = useCallback(() => {
    setState(controller.getState());
  }, [controller]);

  /**
   * Records a barcode decoded by `expo-camera` while the preview was live.
   *
   * `expo-camera` fires `onBarcodeScanned` once per decode, including repeated
   * decodes of the same code as long as it stays in frame. The same shelf
   * product would therefore be counted many times in a single frame if the
   * worker held the phone still, which would inflate the audit. De-duplication
   * happens HERE, so the rule travels with the data and not with the caller.
   *
   * The set comparison keeps order: a new code is appended; a known code is
   * ignored. Order is the only signal the audit has for which side of the
   * shelf the worker scanned first.
   */
  const handleBarcodeScanned = useCallback((result: BarcodeScanningResult) => {
    const code = result?.data;
    if (typeof code !== 'string' || code.length === 0) return;
    setScannedBarcodes((previous) => (previous.includes(code) ? previous : [...previous, code]));
  }, []);

  /**
   * Takes the photo and hands the real bytes to the controller.
   *
   * A capture that comes back without base64 is treated as a failure and NOT
   * retried as a placeholder. Filing a made-up image against a real task is the
   * one outcome this whole screen exists to prevent, so the honest failure is
   * the correct one: the worker sees "çəkiliş alınmadı" and takes it again.
   */
  const handleCapture = useCallback(async () => {
    const camera = cameraRef.current;
    if (!camera) {
      Alert.alert(
        'Kamera hazır deyil',
        'Kamera hələ açılmayıb. Bir neçə saniyə gözləyib yenidən cəhd edin.',
      );
      return;
    }

    try {
      const shot = await camera.takePictureAsync({ base64: true, quality: 0.7, exif: true });
      if (!shot?.base64) {
        throw new Error(
          'Kamera şəkil baytlarını qaytarmadı — auditə saxta şəkil yazılmır. Yenidən çəkin.',
        );
      }

      // Judged from the EXIF the platform returned with these bytes, before the
      // photo can be sent. `exif: true` above is what makes this possible; the
      // assessment is pure and runs on the shutter, so there is no window in
      // which an unjudged photo is sitting on screen.
      const assessment = assessPhotoQuality(shot.exif as Record<string, unknown> | undefined);

      // WHERE THE PHOTO WAS TAKEN, not where the worker signed in. The fresh fix
      // is requested at the moment of capture; if the platform cannot answer, the
      // sign-in fix is used and the review screen says so. Both are real
      // positions. Neither is a constant.
      const freshFix = await acquireFreshFix();
      const position = resolveCapturePosition(userGPS, freshFix);

      const result = await controller.captureLiveAudit({
        source: 'camera',
        userGPS: position.gps,
        isFresh: position.isFresh,
        base64: shot.base64,
        scannedBarcodes,
        photoQuality: assessment,
      });
      setPositionIsFresh(position.isFresh);
      setQuality(assessment);
      setPreviewUri(shot.uri);
      setCaptured(result);
    } catch (e) {
      Alert.alert('Çəkiliş alınmadı', e instanceof Error ? e.message : String(e));
    }
  }, [controller, userGPS, scannedBarcodes]);

  const handleRetake = useCallback(() => {
    setCaptured(null);
    setPreviewUri(null);
    // The position claim belongs to the capture that was taken, not to the screen
    // — a retake has no position yet. Same for the scanned list and the quality
    // verdict: a fresh attempt starts with an empty shelf and an unjudged photo.
    setPositionIsFresh(false);
    setScannedBarcodes([]);
    setQuality(null);
  }, []);

  /**
   * The submission itself. Separated from `handleSubmit` because the flagged
   * path reaches it from an Alert callback, and an async callback inside
   * `Alert.alert`'s button list is easy to get wrong.
   */
  const doSubmit = useCallback(async () => {
    if (!captured) return;
    setSubmitting(true);
    try {
      const result = await controller.processAuditSubmission({
        photoUri: captured.photoUri,
        metadata: captured.metadata,
        base64: captured.base64,
        idempotencyKey: captured.idempotencyKey,
      });
      if (result.status === 'uploaded') {
        setSubmitResult('✅ Audit uğurla göndərildi');
      } else {
        setSubmitResult(
          `📤 Offline növbəyə əlavə olundu (#${result.queueItem?.id.slice(0, 8) ?? '?'})`,
        );
      }
    } catch (e) {
      Alert.alert('Göndərmə alınmadı', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [controller, captured]);

  /**
   * Sends the audit, stopping to ask first when the quality gate flagged it.
   *
   * The gate is not a wall. A dark basement outlet with the right shelf in
   * frame is still evidence, and refusing to send it would push the worker
   * towards taking the photo outside or not at all. So the worker is told what
   * is wrong, offered the retake, and allowed to send anyway — and the verdict
   * is already stamped into the metadata either way, so a supervisor can see
   * which audits came in flagged. The confirmation exists so that "send
   * anyway" is a decision, not an oversight.
   */
  const handleSubmit = useCallback(() => {
    if (!captured) return;

    if (quality !== null && !quality.isAcceptable) {
      Alert.alert(
        'Şəkil keyfiyyətsizdir',
        `${describeQuality(quality)}\n\nYenə də göndərilsin? Audit bunu qeyd edəcək.`,
        [
          { text: 'Yenidən çəkəcəyəm', style: 'cancel', onPress: handleRetake },
          {
            text: 'Yenə də göndər',
            style: 'destructive',
            onPress: () => {
              void doSubmit();
            },
          },
        ],
      );
      return;
    }

    void doSubmit();
  }, [captured, quality, handleRetake, doSubmit]);

  const handleToggleGhost = useCallback(() => {
    controller.toggleGhost();
    refreshState();
  }, [controller, refreshState]);

  const handleToggleGrid = useCallback(() => {
    controller.toggleGrid();
    refreshState();
  }, [controller, refreshState]);

  // Live camera preview, with the guides drawn over it.
  const renderPreview = () => (
    <View style={[styles.previewContainer, { paddingBottom: insets.bottom + 16 }]}>
      <View style={styles.preview}>
        {permission?.granted ? (
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing="back"
            enableTorch={torchOn}
            zoom={zoom}
            onBarcodeScanned={handleBarcodeScanned}
            barcodeScannerSettings={{
              // The set is the retail-relevant subset of `BarcodeType`. QR is
              // kept because some chains print a single QR for a multi-pack;
              // PDF417 and Aztec are omitted because Coca-Cola FMCG shelves do
              // not use them and the scanner would just keep firing on stray
              // packaging graphics. Restricting the list also reduces duplicate
              // fires on visually busy shelves.
              barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'],
            }}
          />
        ) : (
          <View style={styles.permissionBlock}>
            {permission === null ? (
              <>
                <ActivityIndicator color="#FFFFFF" />
                <Text style={styles.previewHint}>Kamera icazəsi yoxlanılır…</Text>
              </>
            ) : (
              <>
                <Text style={styles.permissionTitle}>Kamera icazəsi lazımdır</Text>
                <Text style={styles.permissionBody}>
                  Rəf auditini yalnız canlı çəkilişlə təsdiqləmək olar — qalereyadan şəkil seçmək
                  qəbul edilmir. Buna görə kamera icazəsi olmadan audit göndərilə bilməz.
                </Text>
                <TouchableOpacity
                  testID="camera.requestPermissionButton"
                  accessibilityRole="button"
                  style={styles.permissionButton}
                  onPress={() => {
                    void requestPermission();
                  }}
                  activeOpacity={0.8}
                >
                  <Text style={styles.permissionButtonText}>İcazə ver</Text>
                </TouchableOpacity>
                {permission?.canAskAgain === false ? (
                  <TouchableOpacity
                    style={styles.permissionLink}
                    onPress={() => {
                      void Linking.openSettings();
                    }}
                  >
                    <Text style={styles.permissionLinkText}>Parametrləri aç</Text>
                  </TouchableOpacity>
                ) : null}
              </>
            )}
          </View>
        )}

        {state.gridGuideActive ? (
          <View style={styles.gridOverlay} pointerEvents="none">
            <View style={[styles.gridLine, { left: '33%' }]} />
            <View style={[styles.gridLine, { left: '66%' }]} />
            <View style={[styles.gridLineH, { top: '33%' }]} />
            <View style={[styles.gridLineH, { top: '66%' }]} />
          </View>
        ) : null}

        {/* The planogram reference, drawn over the live preview at the
            controller's opacity. Until 2026-09-20 this area held only a badge
            reading "👻 Ghost overlay aktiv": no image was ever rendered, while
            every audit still recorded `ghost_overlay_used: true`. The worker
            was asked to match a shelf against a reference they could not see,
            and the audit trail said the comparison had been offered. */}
        {state.ghostOverlayActive && task.reference_image_url ? (
          // `pointerEvents` belongs to View, not to Image — putting it on the
          // Image is a type error, and the grid overlay above already solves it
          // this way. The wrapper keeps the overlay from swallowing taps meant
          // for the shutter.
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <Image
              testID="camera.ghostOverlay"
              source={{ uri: task.reference_image_url }}
              style={[StyleSheet.absoluteFill, { opacity: state.ghostOpacity }]}
              resizeMode="contain"
            />
          </View>
        ) : null}

        {/* The badge reports what is actually on screen. Claiming the overlay
            is "aktiv" for a task that carries no reference image would be the
            same lie in a smaller place. */}
        {state.ghostOverlayActive ? (
          <View style={styles.ghostBadge} pointerEvents="none">
            <Text style={styles.ghostBadgeText}>
              {task.reference_image_url ? '👻 Ghost overlay aktiv' : 'Ghost: istinad şəkli yoxdur'}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Controls */}
      <View style={styles.controlsRow}>
        <TouchableOpacity style={styles.controlButton} onPress={handleToggleGhost}>
          <Text style={styles.controlButtonText}>
            {state.ghostOverlayActive ? '👻 Ghost: Açıq' : 'Ghost: Bağlı'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.controlButton} onPress={handleToggleGrid}>
          <Text style={styles.controlButtonText}>
            {state.gridGuideActive ? '⊞ Grid: Açıq' : 'Grid: Bağlı'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Hardware. Torch because a general-trade outlet is often lit by one
          bulb, and zoom because a shelf has to fill the frame. Both are real
          `expo-camera` props — no new dependency, no new permission. */}
      <View style={styles.controlsRow}>
        <TouchableOpacity
          testID="camera.torchButton"
          accessibilityRole="button"
          style={[styles.controlButton, torchOn && styles.controlButtonActive]}
          onPress={() => setTorchOn((on) => !on)}
          activeOpacity={0.8}
        >
          <Text style={[styles.controlButtonText, torchOn && styles.controlButtonActiveText]}>
            {torchOn ? '🔦 İşıq: Açıq' : '🔦 İşıq: Bağlı'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="camera.zoomButton"
          accessibilityRole="button"
          style={styles.controlButton}
          onPress={() => {
            setZoomStep((step) => (step + 1) % ZOOM_STEPS.length);
          }}
          activeOpacity={0.8}
        >
          <Text style={styles.controlButtonText}>🔍 Zoom: {Math.round(zoom * 100)}%</Text>
        </TouchableOpacity>
      </View>

      {/* Barcode tally. Read off the live preview as `expo-camera` decodes
          each shelf product; counted here so the worker can see what has been
          captured before pressing the shutter. The field is `testID`ed so the
          XCUI test can assert the list grew when a known product was framed. */}
      <View style={styles.barcodeBadge} pointerEvents="none">
        <Text style={styles.barcodeBadgeText} testID="camera.barcodeBadge">
          {scannedBarcodes.length === 0
            ? '📊 Barkod skan edilməyib'
            : `📊 ${scannedBarcodes.length} barkod skan edildi`}
        </Text>
      </View>

      {/* Shutter. Disabled without permission, because there is nothing to
          capture from — an enabled shutter that can only fail is worse than a
          shutter that says why it is off. */}
      <TouchableOpacity
        testID="camera.captureButton"
        accessibilityRole="button"
        accessibilityState={{ disabled: !permission?.granted || state.isCapturing }}
        style={[
          styles.captureButton,
          (!permission?.granted || state.isCapturing) && styles.captureButtonDisabled,
        ]}
        onPress={() => {
          void handleCapture();
        }}
        disabled={!permission?.granted || state.isCapturing}
      >
        {state.isCapturing ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <View style={styles.captureButtonInner} />
        )}
      </TouchableOpacity>
    </View>
  );

  // Review after capture
  const renderReview = () => (
    <ScrollView contentContainerStyle={[styles.reviewContent, { paddingBottom: insets.bottom + 40 }]}>
      <Text style={styles.reviewTitle}>✅ Şəkil çəkildi</Text>

      {/* The photo itself, so "review before sending" is actually possible.
          Before this the worker was asked to confirm a capture they could not
          see. */}
      {previewUri ? (
        <Image
          testID="camera.capturedPreview"
          source={{ uri: previewUri }}
          style={styles.capturedImage}
          resizeMode="contain"
        />
      ) : null}

      {captured?.simulated ? (
        <View style={styles.simulatedBanner}>
          <Text style={styles.simulatedText}>
            ⚠️ Bu çəkilişdə kamera baytları yoxdur — audit saxta şəkillə göndərilməyəcək.
          </Text>
        </View>
      ) : null}

      {/* The quality gate's verdict, shown before the worker can send. Three
          states, not two: a photo the heuristic could not judge says so
          instead of passing as "fine". */}
      {quality !== null && photoQualityStatus(quality) === 'flagged' ? (
        <View style={styles.qualityBanner} testID="camera.qualityWarning">
          <Text style={styles.qualityTitle}>⚠️ Şəklin keyfiyyəti aşağıdır</Text>
          <Text style={styles.qualityText}>{describeQuality(quality)}</Text>
          <Text style={styles.qualityHint}>
            Yenidən çəkmək daha yaxşıdır. Yenə də göndərsəniz, audit bunu qeyd edəcək və supervisor
            görəcək.
          </Text>
        </View>
      ) : null}

      {quality !== null && photoQualityStatus(quality) === 'no_signal' ? (
        <View style={styles.qualityUnknownBanner} testID="camera.qualityUnknown">
          <Text style={styles.qualityUnknownText}>
            ℹ️ Şəklin keyfiyyəti yoxlanıla bilmədi — kamera lazımi məlumatı vermədi. Bu, şəklin pis
            olması demək deyil, sadəcə yoxlanılmadığı deməkdir.
          </Text>
        </View>
      ) : null}

      {/* The position is real either way, but a sign-in position is a WEAKER
          claim than a capture position, and the worker is the one who can tell
          whether that matters (did they walk to the aisle, or to another shop?).
          It is stated rather than hidden, for the same reason `simulated` is. */}
      {!positionIsFresh ? (
        <View style={styles.stalePositionBanner}>
          <Text style={styles.stalePositionText}>
            ⚠️ Çəkiliş anında mövqe yenilənmədi — auditə girişdə təsdiqlənmiş mövqe yazılıb. Siqnal
            zəifdirsə, mağazada bir az gözləyib yenidən çəkin.
          </Text>
        </View>
      ) : null}

      {/* Checklist answers summary */}
      {checklistAnswers.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Çeklist cavabları</Text>
          {checklistAnswers.map((a, idx) => (
            <View key={a.questionId} style={styles.answerRow}>
              <Text style={styles.answerQuestion}>
                {idx + 1}. {a.questionText}
              </Text>
              <Text style={styles.answerValue}>{a.answer}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* Metadata */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Audit məlumatları</Text>
        <Text style={styles.metaText}>Mağaza: {store.name}</Text>
        <Text style={styles.metaText}>Tapşırıq: {task.title}</Text>
        <Text style={styles.metaText}>
          Lokasiya: {userGPS.latitude.toFixed(4)}, {userGPS.longitude.toFixed(4)}
        </Text>
      </View>

      {submitResult ? (
        <View style={styles.resultBanner}>
          <Text style={styles.resultText}>{submitResult}</Text>
          <TouchableOpacity style={styles.doneButton} onPress={onComplete}>
            <Text style={styles.doneButtonText}>Tamamlandı → Tapşırıqlara qayıt</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.actionRow}>
          <TouchableOpacity style={styles.retakeButton} onPress={handleRetake}>
            <Text style={styles.retakeButtonText}>🔄 Yenidən çək</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="camera.submitButton"
            style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
            onPress={() => {
              void handleSubmit();
            }}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.submitButtonText}>📤 Göndər</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <TouchableOpacity onPress={onCancel} style={styles.backButton}>
          <Text style={styles.backButtonText}>← Ləğv et</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {task.title}
        </Text>
        <View style={styles.backButton} />
      </View>

      {captured ? renderReview() : renderPreview()}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#000000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: '#000000',
  },
  backButton: {
    minWidth: 70,
  },
  backButtonText: {
    fontSize: 15,
    color: '#FFFFFF',
  },
  headerTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    color: '#FFFFFF',
    textAlign: 'center',
    marginHorizontal: 8,
  },
  previewContainer: {
    flex: 1,
    justifyContent: 'space-between',
  },
  preview: {
    flex: 1,
    margin: 16,
    backgroundColor: '#1A1A1A',
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  previewHint: {
    marginTop: 12,
    fontSize: 14,
    color: '#AAAAAA',
  },
  permissionBlock: {
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  permissionTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  permissionBody: {
    fontSize: 13,
    color: '#AAAAAA',
    lineHeight: 19,
    textAlign: 'center',
  },
  permissionButton: {
    marginTop: 18,
    paddingVertical: 10,
    paddingHorizontal: 22,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
  },
  permissionButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111111',
  },
  permissionLink: {
    marginTop: 12,
    padding: 6,
  },
  permissionLinkText: {
    fontSize: 14,
    color: '#7FB2E5',
    textDecorationLine: 'underline',
  },
  ghostBadge: {
    position: 'absolute',
    top: 12,
    left: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  ghostBadgeText: {
    fontSize: 12,
    color: '#FFFFFF',
  },
  capturedImage: {
    width: '100%',
    height: 260,
    borderRadius: 12,
    backgroundColor: '#1A1A1A',
  },
  gridOverlay: {
    ...StyleSheet.absoluteFill,
  },
  gridLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  gridLineH: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    marginBottom: 16,
  },
  controlButton: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  controlButtonText: {
    fontSize: 14,
    color: '#FFFFFF',
  },
  // A lit torch is a state the worker must be able to see at a glance, or they
  // will walk into a customer with the flashlight on.
  controlButtonActive: {
    backgroundColor: 'rgba(255,214,10,0.85)',
  },
  controlButtonActiveText: {
    fontSize: 14,
    color: '#1A1A1A',
  },
  barcodeBadge: {
    alignSelf: 'center',
    marginBottom: 16,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  barcodeBadgeText: {
    fontSize: 13,
    color: '#FFFFFF',
    fontWeight: '500',
  },
  captureButton: {
    alignSelf: 'center',
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  captureButtonDisabled: {
    opacity: 0.5,
  },
  captureButtonInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#B00020',
  },
  reviewContent: {
    padding: 20,
  },
  reviewTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: 20,
  },
  stalePositionBanner: {
    marginTop: 10,
    borderRadius: 8,
    padding: 12,
    backgroundColor: 'rgba(255,193,7,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,193,7,0.6)',
  },
  stalePositionText: {
    fontSize: 13,
    color: '#FFC107',
  },
  simulatedBanner: {
    backgroundColor: 'rgba(255,193,7,0.15)',
    borderRadius: 10,
    padding: 14,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,193,7,0.4)',
  },
  simulatedText: {
    fontSize: 14,
    color: '#FFC107',
    lineHeight: 20,
  },
  // Red, not amber: the amber banners elsewhere say "this claim is weaker than
  // it looks". This one says "do not send this photo" — a different instruction.
  qualityBanner: {
    backgroundColor: 'rgba(229,57,53,0.16)',
    borderRadius: 10,
    padding: 14,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(229,57,53,0.65)',
  },
  qualityTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FF8A80',
    marginBottom: 6,
  },
  qualityText: {
    fontSize: 14,
    color: '#FFCDD2',
    lineHeight: 20,
  },
  qualityHint: {
    marginTop: 8,
    fontSize: 13,
    color: '#E0A0A0',
    lineHeight: 19,
  },
  // Neutral, not red and not green: "we did not judge this" is its own outcome
  // and must not borrow the colour of either verdict.
  qualityUnknownBanner: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    padding: 14,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  qualityUnknownText: {
    fontSize: 13,
    color: '#CCCCCC',
    lineHeight: 19,
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#888888',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  answerRow: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  answerQuestion: {
    fontSize: 14,
    color: '#CCCCCC',
    lineHeight: 20,
  },
  answerValue: {
    marginTop: 6,
    fontSize: 15,
    fontWeight: '500',
    color: '#FFFFFF',
  },
  metaText: {
    fontSize: 14,
    color: '#AAAAAA',
    marginBottom: 4,
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 8,
  },
  retakeButton: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  retakeButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  submitButton: {
    flex: 1,
    backgroundColor: '#0066CC',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  resultBanner: {
    marginTop: 8,
    alignItems: 'center',
  },
  resultText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#4CAF50',
    marginBottom: 16,
  },
  doneButton: {
    backgroundColor: '#0066CC',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  doneButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
