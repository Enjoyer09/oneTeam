/**
 * oneTeam mobile — Task Detail + Checklist screen
 * ============================================================================
 *
 * WHAT THIS IS
 * ------------
 * The screen a field worker sees after picking a task: the planogram rules,
 * the checklist questions, and the button that leads to the camera. Every
 * value comes from the same `TaskDetailController` the headless harness used,
 * so the screen cannot drift from the policy.
 *
 * WHY THE CHECKLIST IS HERE AND NOT A SEPARATE SCREEN
 * ---------------------------------------------------
 * The plan names five screens (Login, TaskList, TaskDetail, Checklist, Camera).
 * In practice a worker does not navigate to a checklist — they open a task and
 * the checklist is part of what they see. Splitting it would mean an extra tap
 * and an extra back-button decision for no gain. So this file renders both:
 * the task header at the top, the checklist in the middle, and the camera
 * button at the bottom.
 *
 * The checklist state is local to this screen and is passed to the camera
 * screen so the submission can include the answers.
 */

import { useState, useCallback } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  TextInput,
  Alert,
  Image,
} from 'react-native';
import type { MobileTask, MobileStore, GPSCoordinates } from '../types';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ChecklistQuestion } from '@oneteam/types';
import { priorityLabel, deadlineLabel } from '../utils/presentation';
import { checklistDrafts } from '../services/checklistDrafts';
import { answerError, answerValue } from '../utils/checklist';
import { TaskDetailController } from './TaskListScreen';
import { palette, spacing, typography } from '../theme';

export type ChecklistAnswer = {
  questionId: string;
  questionText: string;
  answer: string;
  value?: string | number | boolean;
};

export interface TaskDetailScreenProps {
  task: MobileTask;
  store: MobileStore;
  /**
   * The fix the sign-in geofence was evaluated against, carried through to the
   * audit so the evidence records a real position. Required, with no default —
   * see the note on `Screen` in `Root.tsx` for why.
   */
  userGPS: GPSCoordinates;
  onBack: () => void;
  onOpenCamera: (params: {
    task: MobileTask;
    store: MobileStore;
    checklistAnswers: ChecklistAnswer[];
    userGPS: GPSCoordinates;
  }) => void;
}

export function TaskDetailScreen({
  task,
  store,
  userGPS,
  onBack,
  onOpenCamera,
}: TaskDetailScreenProps) {
  const insets = useSafeAreaInsets();
  const controller = new TaskDetailController(task, store);
  const details = controller.getPlanogramDetails();

  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    checklistDrafts.get(store.id, task.id),
  );

  const [referenceFailed, setReferenceFailed] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const updateAnswer = (id: string, text: string) => {
    const next = { ...answers, [id]: text };
    setAnswers(next);
    void checklistDrafts
      .save(store.id, task.id, next)
      .then(() => setDraftError(null))
      .catch(() =>
        setDraftError('Qaralama cihazda saxlanmadı. Tətbiqi bağlamadan yenidən cəhd edin.'),
      );
  };
  const allAnswered = details.checklistQuestions.every((q) => !answerError(q, answers[q.id]));

  const handleOpenCamera = useCallback(() => {
    if (!allAnswered) {
      Alert.alert('Çeklist tamamlanmayıb', 'Zəhmət olmasa bütün suallara cavab verin.');
      return;
    }
    const checklistAnswers: ChecklistAnswer[] = details.checklistQuestions
      .filter((q) => answers[q.id]?.trim())
      .map((q) => ({
        questionId: q.id,
        questionText: q.question ?? q.label ?? '',
        answer:
          (q.type ?? 'boolean') === 'boolean'
            ? answers[q.id] === 'true'
              ? 'Bəli'
              : 'Xeyr'
            : answers[q.id].trim(),
        value: answerValue(q, answers[q.id]),
      }));
    onOpenCamera({ task, store, checklistAnswers, userGPS });
  }, [allAnswered, answers, details.checklistQuestions, task, store, userGPS, onOpenCamera]);

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Tapşırıqlar siyahısına qayıt"
          onPress={onBack}
          style={styles.backButton}
        >
          <Text style={styles.backButtonText}>← Geri</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {details.title}
        </Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        {draftError ? (
          <Text accessibilityRole="alert" style={{ color: '#B00020' }}>
            {draftError}
          </Text>
        ) : null}
        {/* Store + deadline */}
        <View style={styles.metaRow}>
          <Text style={styles.metaText}>{details.storeName}</Text>
          <Text
            style={[
              styles.priorityBadge,
              details.priority === 'urgent'
                ? styles.priorityUrgent
                : details.priority === 'high'
                  ? styles.priorityHigh
                  : styles.priorityNormal,
            ]}
          >
            {priorityLabel[details.priority]}
          </Text>
        </View>
        <Text style={styles.deadlineText}>Son tarix: {deadlineLabel(details.deadline)}</Text>

        {/* Instructions */}
        {details.instructions ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Təlimat</Text>
            <Text style={styles.sectionBody}>{details.instructions}</Text>
          </View>
        ) : null}

        {/* Planogram rules */}
        {details.planogramRules.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Rəf düzülüşü qaydaları</Text>
            {details.planogramRules.map((rule, idx) => (
              <View key={idx} style={styles.ruleRow}>
                <Text style={styles.ruleBullet}>•</Text>
                <Text style={styles.ruleText}>
                  {rule.label} ({rule.sku}): ön cərgədə minimum {rule.minFacings} ədəd
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* Reference image hint */}
        {details.referenceImageUrl ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Nümunə şəkil</Text>
            {referenceFailed ? (
              <Text style={styles.hintText}>Nümunə foto yüklənmədi. Bağlantını yoxlayın.</Text>
            ) : (
              <Image
                source={{ uri: details.referenceImageUrl }}
                accessibilityLabel="Nümunə rəf düzülüşü"
                resizeMode="contain"
                style={{ width: '100%', aspectRatio: 1, backgroundColor: '#F1F5F9' }}
                onError={() => setReferenceFailed(true)}
              />
            )}
            <Text style={styles.hintText}>
              Kamera ekranında nümunə şəklini canlı görüntünün üzərində göstərə bilərsiniz.
            </Text>
          </View>
        ) : null}

        {/* Checklist */}
        {details.checklistQuestions.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              Çeklist ({details.checklistQuestions.filter((q) => answers[q.id]?.trim()).length}/
              {details.checklistQuestions.length})
            </Text>
            {details.checklistQuestions.map((q, idx) => (
              <ChecklistQuestionRow
                key={q.id}
                index={idx + 1}
                question={q}
                value={answers[q.id] ?? ''}
                onChange={(text) => updateAnswer(q.id, text)}
              />
            ))}
          </View>
        ) : (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Çeklist</Text>
            <Text style={styles.hintText}>Bu tapşırıq üçün çeklist yoxdur.</Text>
          </View>
        )}

        {/* Bottom spacer so content clears the fixed button */}
        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Fixed bottom button */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 12 }]}>
        <TouchableOpacity
          testID="taskDetail.openCameraButton"
          accessibilityRole="button"
          accessibilityState={{ disabled: !allAnswered }}
          disabled={!allAnswered}
          style={[styles.cameraButton, !allAnswered && styles.cameraButtonDisabled]}
          onPress={handleOpenCamera}
          activeOpacity={0.8}
        >
          <Text style={styles.cameraButtonText}>
            {allAnswered ? '📷 Kamera aç' : 'Çeklisti tamamla'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function ChecklistQuestionRow({
  index,
  question,
  value,
  onChange,
}: {
  index: number;
  question: ChecklistQuestion;
  value: string;
  onChange: (text: string) => void;
}) {
  const label = question.question ?? question.label ?? 'Sual';
  const type = question.type ?? 'boolean';
  const choices =
    type === 'boolean'
      ? ['true', 'false']
      : type === 'single_choice'
        ? (question.options ?? [])
        : null;
  const error = value ? answerError(question, value) : null;
  return (
    <View style={styles.questionCard}>
      <Text style={styles.questionText}>
        {index}. {label}
        {question.required === false ? ' (istəyə bağlı)' : ''}
      </Text>
      {choices ? (
        choices.map((choice) => (
          <TouchableOpacity
            key={choice}
            accessibilityRole="radio"
            accessibilityLabel={`${label}: ${type === 'boolean' ? (choice === 'true' ? 'Bəli' : 'Xeyr') : choice}`}
            accessibilityState={{ checked: value === choice }}
            onPress={() => onChange(choice)}
            style={[
              styles.questionInput,
              {
                minHeight: 44,
                marginBottom: 8,
                borderColor: value === choice ? '#0066CC' : '#CCCCCC',
              },
            ]}
          >
            <Text style={{ color: '#111111' }}>
              {value === choice ? '● ' : '○ '}
              {type === 'boolean' ? (choice === 'true' ? 'Bəli' : 'Xeyr') : choice}
            </Text>
          </TouchableOpacity>
        ))
      ) : (
        <TextInput
          style={styles.questionInput}
          value={value}
          onChangeText={onChange}
          accessibilityLabel={label}
          placeholder={type === 'number' ? 'Rəqəm daxil edin' : 'Cavabınızı yazın...'}
          placeholderTextColor="#666666"
          keyboardType={type === 'number' ? 'numbers-and-punctuation' : 'default'}
          multiline={type !== 'number'}
          textAlignVertical="top"
        />
      )}
      {question.unit ? <Text>{question.unit}</Text> : null}
      {question.required === false && value ? (
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => onChange('')}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Text>Cavabı təmizlə</Text>
        </TouchableOpacity>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: '#B00020' }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  backButton: {
    minHeight: 44,
    justifyContent: 'center',
    minWidth: 60,
  },
  backButtonText: {
    fontSize: 15,
    color: palette.focus,
  },
  headerTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    color: palette.text,
    textAlign: 'center',
    marginHorizontal: 8,
  },
  content: {
    padding: spacing.md,
    paddingTop: 8,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  metaText: {
    fontSize: 14,
    color: palette.textSecondary,
  },
  deadlineText: {
    fontSize: 13,
    color: palette.textSecondary,
    marginTop: 2,
  },
  priorityBadge: {
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    overflow: 'hidden',
  },
  priorityUrgent: {
    backgroundColor: '#B00020',
    color: '#FFFFFF',
  },
  priorityHigh: {
    backgroundColor: '#E65100',
    color: '#FFFFFF',
  },
  priorityNormal: {
    backgroundColor: '#E0E0E0',
    color: '#444444',
  },
  section: {
    marginTop: 20,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: palette.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  sectionBody: {
    fontSize: 15,
    lineHeight: 22,
    color: '#333333',
  },
  ruleRow: {
    flexDirection: 'row',
    marginTop: 6,
  },
  ruleBullet: {
    fontSize: 15,
    color: '#666666',
    marginRight: 8,
  },
  ruleText: {
    flex: 1,
    fontSize: 15,
    color: '#333333',
    lineHeight: 21,
  },
  hintText: {
    fontSize: 14,
    color: '#666666',
    lineHeight: 20,
  },
  questionCard: {
    backgroundColor: palette.surface,
    borderRadius: 10,
    padding: 14,
    marginTop: 10,
  },
  questionText: {
    fontSize: 15,
    fontWeight: '500',
    color: '#111111',
    lineHeight: 21,
  },
  questionInput: {
    marginTop: 10,
    minHeight: 60,
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 8,
    padding: 10,
    fontSize: 15,
    color: '#111111',
    backgroundColor: '#FFFFFF',
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: '#FFFFFF',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E0E0E0',
  },
  cameraButton: {
    backgroundColor: '#0066CC',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  cameraButtonDisabled: {
    backgroundColor: '#CCCCCC',
  },
  cameraButtonText: {
    fontSize: typography.body,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
