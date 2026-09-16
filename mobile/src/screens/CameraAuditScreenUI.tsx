/**
 * oneTeam mobile — Camera Audit screen (React Native UI)
 * ============================================================================
 *
 * WHAT THIS IS
 * ------------
 * The screen where the field worker captures the shelf photo. It shows the
 * camera preview (simulated here, since `expo-camera` is not installed yet),
 * the ghost overlay toggle, the grid guide toggle, and the capture button.
 *
 * After capture, the photo is either uploaded immediately (online) or queued
 * for later (offline). The screen then returns to the task list.
 *
 * WHY THIS IS A SEPARATE FILE
 * ---------------------------
 * `CameraAuditScreen.tsx` holds `CameraAuditController`, a plain class with no
 * React in it. Keeping the UI separate means the controller stays importable
 * from tests without pulling in `react-native`.
 */

import { useState, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
} from 'react-native';
import { CameraAuditController, type CapturedPhoto } from './CameraAuditScreen';
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

export function CameraAuditScreenUI({
  task,
  store,
  userGPS,
  checklistAnswers,
  onComplete,
  onCancel,
}: CameraAuditScreenProps) {
  const [controller] = useState(() => new CameraAuditController(task, store));
  const [state, setState] = useState(controller.getState());
  const [captured, setCaptured] = useState<CapturedPhoto | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string | null>(null);

  const refreshState = useCallback(() => {
    setState(controller.getState());
  }, [controller]);

  const handleCapture = useCallback(async () => {
    try {
      const result = await controller.captureLiveAudit({
        source: 'camera',
        userGPS,
      });
      setCaptured(result);
    } catch (e) {
      Alert.alert('Çəkiliş alınmadı', e instanceof Error ? e.message : String(e));
    }
  }, [controller, userGPS]);

  const handleSubmit = useCallback(async () => {
    if (!captured) return;
    setSubmitting(true);
    try {
      const result = await controller.processAuditSubmission({
        photoUri: captured.photoUri,
        metadata: captured.metadata,
        base64: captured.base64,
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

  const handleToggleGhost = useCallback(() => {
    controller.toggleGhost();
    refreshState();
  }, [controller, refreshState]);

  const handleToggleGrid = useCallback(() => {
    controller.toggleGrid();
    refreshState();
  }, [controller, refreshState]);

  // Simulated camera preview area
  const renderPreview = () => (
    <View style={styles.previewContainer}>
      <View style={styles.preview}>
        <Text style={styles.previewPlaceholder}>📷 Kamera önizləməsi</Text>
        <Text style={styles.previewHint}>
          {state.ghostOverlayActive ? '👻 Ghost overlay aktiv' : 'Ghost overlay söndürülüb'}
        </Text>
        {state.gridGuideActive ? (
          <View style={styles.gridOverlay}>
            <View style={[styles.gridLine, { left: '33%' }]} />
            <View style={[styles.gridLine, { left: '66%' }]} />
            <View style={[styles.gridLineH, { top: '33%' }]} />
            <View style={[styles.gridLineH, { top: '66%' }]} />
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

      {/* Capture button */}
      <TouchableOpacity
        style={[styles.captureButton, state.isCapturing && styles.captureButtonDisabled]}
        onPress={handleCapture}
        disabled={state.isCapturing}
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
    <ScrollView contentContainerStyle={styles.reviewContent}>
      <Text style={styles.reviewTitle}>✅ Şəkil çəkildi</Text>

      {captured?.simulated ? (
        <View style={styles.simulatedBanner}>
          <Text style={styles.simulatedText}>
            ⚠️ Bu, simulyasiya edilmiş çəkilişdir — real kamera modulu quraşdırılmayıb.
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
          <TouchableOpacity style={styles.retakeButton} onPress={() => setCaptured(null)}>
            <Text style={styles.retakeButtonText}>🔄 Yenidən çək</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
            onPress={handleSubmit}
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
      <View style={styles.header}>
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
    paddingTop: 60,
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
    paddingBottom: 34,
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
  previewPlaceholder: {
    fontSize: 48,
  },
  previewHint: {
    marginTop: 12,
    fontSize: 14,
    color: '#AAAAAA',
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
    paddingBottom: 40,
  },
  reviewTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: 20,
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
