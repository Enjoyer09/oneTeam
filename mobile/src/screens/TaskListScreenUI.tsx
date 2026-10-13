/**
 * oneTeam mobile — Task List screen (React Native UI)
 * ============================================================================
 *
 * WHAT THIS IS
 * ------------
 * The screen a field worker sees after logging in: the store's open tasks,
 * each with its priority, deadline, and status. Tapping a task opens the
 * detail screen. Every value comes from `TaskListController`, which is the
 * same controller the headless harness used.
 *
 * WHY THIS IS A SEPARATE FILE
 * ---------------------------
 * `TaskListScreen.tsx` holds `TaskListController` and `TaskDetailController`,
 * both plain classes with no React in them. Keeping the UI in a separate file
 * means the controllers stay importable from tests and from the coordinator
 * without pulling in `react-native`.
 */

import { useEffect, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import type { MobileTask, MobileStore } from '../types';
import { priorityLabel, deadlineLabel } from '../utils/presentation';
import { buildSyncMessage } from '../services/syncMessage';

import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TaskListController } from './TaskListScreen';
import { mobileApp } from '../App';
import { offlineQueueService } from '../services/offlineQueue';
import { palette, spacing, typography } from '../theme';

export interface TaskListScreenProps {
  store: MobileStore;
  onSelectTask: (task: MobileTask) => void;
  onLogout: () => void;
  onOpenHistory: () => void;
}

export function TaskListScreenUI({
  store,
  onSelectTask,
  onLogout,
  onOpenHistory,
}: TaskListScreenProps) {
  const insets = useSafeAreaInsets();
  const controller = new TaskListController();
  const [tasks, setTasks] = useState<MobileTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Offline-queue sync state. The queue is device-local, so the count and the
  // "sync now" action live on the screen rather than coming from the task API.
  const [pendingSync, setPendingSync] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  // How many audits are waiting to be sent. Read defensively: the queue refuses
  // to report a count before it has been loaded, and although the app entry loads
  // it at startup, a guard here keeps the task list from crashing if that order
  // ever changes.
  const refreshPending = () => {
    try {
      setPendingSync(offlineQueueService.getPendingCount());
    } catch {
      setPendingSync(null);
    }
  };

  const load = async () => {
    try {
      setError(null);
      const loaded = await controller.loadTasks(store.id);
      setTasks(loaded);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
      refreshPending();
    }
  };

  /**
   * Sends everything waiting in the offline queue, on the worker's command.
   *
   * `triggerManualSync` waives the automatic retry cap — a person pressing the
   * button is new information the cap is not there to overrule. The result is
   * summarised so the worker can see that something happened rather than guessing
   * from a silent button.
   */
  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncMessage(null);
    try {
      const result = await mobileApp.history.triggerManualSync();
      // `skippedCount` says how many left the automatic path this drain;
      // `getPendingCount()` says how many audits are still unsent in total. The
      // second is what catches a stranded item the counters did not attribute
      // to this run — and it is read AFTER the drain, so it reflects the truth
      // rather than the intent.
      const stillPending = offlineQueueService.getPendingCount();
      setSyncMessage(buildSyncMessage(result, stillPending > 0));
    } catch (e) {
      setSyncMessage('Sinxronizasiya alınmadı: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSyncing(false);
      refreshPending();
    }
  };

  useEffect(() => offlineQueueService.subscribe(refreshPending), []);

  useEffect(() => {
    void load();
  }, [store.id]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0066CC" />
        <Text style={styles.loadingText}>Tapşırıqlar yüklənir…</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.headerTitle}>{store.name}</Text>
        <TouchableOpacity
          testID="taskList.syncButton"
          accessibilityRole="button"
          onPress={() => {
            void handleSync();
          }}
          disabled={syncing}
          style={styles.syncButton}
        >
          {syncing ? (
            <ActivityIndicator size="small" color="#0066CC" />
          ) : (
            <Text style={styles.syncText}>
              Növbəni göndər{pendingSync !== null && pendingSync > 0 ? ` (${pendingSync})` : ''}
            </Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" onPress={onLogout} style={styles.logoutButton}>
          <Text style={styles.logoutText}>Çıxış</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        accessibilityRole="button"
        onPress={onOpenHistory}
        style={{
          minHeight: 48,
          justifyContent: 'center',
          paddingHorizontal: 16,
          backgroundColor: '#F0F6FF',
        }}
      >
        <Text style={{ color: '#0055AA', fontSize: 16, fontWeight: '600' }}>Auditlərim →</Text>
      </TouchableOpacity>
      {syncMessage ? (
        <View style={styles.syncBanner}>
          <Text style={styles.syncBannerText}>{syncMessage}</Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>❌ {error}</Text>
          <TouchableOpacity
            onPress={() => {
              void load();
            }}
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Yenidən cəhd et</Text>
          </TouchableOpacity>
        </View>
      ) : tasks.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>Bu mağazada açıq tapşırıq yoxdur.</Text>
        </View>
      ) : (
        <FlatList
          data={tasks}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 16 }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void load();
              }}
            />
          }
          renderItem={({ item }) => <TaskRow task={item} onPress={() => onSelectTask(item)} />}
        />
      )}
    </View>
  );
}

function TaskRow({ task, onPress }: { task: MobileTask; onPress: () => void }) {
  const priorityStyle =
    task.priority === 'urgent'
      ? styles.priorityUrgent
      : task.priority === 'high'
        ? styles.priorityHigh
        : styles.priorityNormal;

  const priorityText = priorityLabel[task.priority];

  return (
    <TouchableOpacity
      testID="taskList.taskRow"
      accessibilityRole="button"
      accessibilityLabel={`${task.title}. ${priorityText}. Son tarix: ${deadlineLabel(task.deadline)}`}
      style={styles.taskCard}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.taskHeader}>
        <Text style={styles.taskTitle} numberOfLines={2}>
          {task.title}
        </Text>
        <Text style={[styles.priorityBadge, priorityStyle]}>{priorityText}</Text>
      </View>
      <Text style={styles.taskDeadline}>Son tarix: {deadlineLabel(task.deadline)}</Text>
      {task.description ? (
        <Text style={styles.taskDescription} numberOfLines={2}>
          {task.description}
        </Text>
      ) : null}
    </TouchableOpacity>
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
    borderBottomColor: '#E0E0E0',
  },
  headerTitle: {
    fontSize: typography.title,
    fontWeight: '700',
    color: palette.text,
    flex: 1,
  },
  logoutButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  logoutText: {
    fontSize: 15,
    color: palette.danger,
  },
  syncButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 44,
    alignItems: 'center',
  },
  syncText: {
    fontSize: 15,
    color: palette.focus,
    fontWeight: '600',
  },
  syncBanner: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#F0F6FF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#D6E4FF',
  },
  syncBannerText: {
    fontSize: 13,
    color: '#0066CC',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 15,
    color: '#666666',
  },
  errorText: {
    fontSize: 15,
    color: '#B00020',
    textAlign: 'center',
    lineHeight: 22,
  },
  retryButton: {
    marginTop: 16,
    backgroundColor: '#0066CC',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  emptyText: {
    fontSize: 15,
    color: '#666666',
    textAlign: 'center',
  },
  listContent: {
    padding: spacing.md,
  },
  taskCard: {
    backgroundColor: palette.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.border,
    padding: spacing.md,
    marginBottom: 12,
  },
  taskHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  taskTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: palette.text,
    lineHeight: 22,
    marginRight: 10,
  },
  priorityBadge: {
    fontSize: 13,
    fontWeight: '700',
    paddingHorizontal: 7,
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
    backgroundColor: '#E8E8E8',
    color: palette.textSecondary,
  },
  taskDeadline: {
    marginTop: 8,
    fontSize: 13,
    color: palette.textSecondary,
  },
  taskDescription: {
    marginTop: 6,
    fontSize: 14,
    color: palette.textSecondary,
    lineHeight: 20,
  },
});
