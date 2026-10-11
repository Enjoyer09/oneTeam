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
import { buildSyncMessage } from '../services/syncMessage';

import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TaskListController } from './TaskListScreen';
import { mobileApp } from '../App';
import { offlineQueueService } from '../services/offlineQueue';

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
  const [pendingSync, setPendingSync] = useState(0);
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
      setPendingSync(0);
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

  useEffect(() => {
    void load();
  }, [store.id]);

  // Keep the "Növbəni göndər (N)" badge live. The queue drains on reconnection,
  // on foreground and at startup — none of which this screen initiates — so a
  // count read only on load/refresh goes stale the moment a background drain
  // empties the queue. Registering the queue's own change listener updates the
  // badge the instant the queue changes; cleared on unmount so a backgrounded
  // screen is not retained by the singleton.
  useEffect(() => {
    offlineQueueService.setOnQueueChange((count) => setPendingSync(count));
    return () => offlineQueueService.setOnQueueChange(null);
  }, []);

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
              Növbəni göndər{pendingSync > 0 ? ` (${pendingSync})` : ''}
            </Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          testID="taskList.historyButton"
          accessibilityRole="button"
          accessibilityLabel="Audit tarixçəsi və göndərilməmiş növbə"
          onPress={onOpenHistory}
          style={styles.historyButton}
        >
          <Text style={styles.historyText}>
            Tarixçə{pendingSync > 0 ? ` (${pendingSync})` : ''}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onLogout}
          accessibilityRole="button"
          accessibilityLabel="Çıxış"
          style={styles.logoutButton}
        >
          <Text style={styles.logoutText}>Çıxış</Text>
        </TouchableOpacity>
      </View>

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

  const priorityLabel = task.priority.toUpperCase();

  return (
    <TouchableOpacity
      testID="taskList.taskRow"
      style={styles.taskCard}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.taskHeader}>
        <Text style={styles.taskTitle} numberOfLines={2}>
          {task.title}
        </Text>
        <Text style={[styles.priorityBadge, priorityStyle]}>{priorityLabel}</Text>
      </View>
      <Text style={styles.taskDeadline}>Son tarix: {task.deadline}</Text>
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
    backgroundColor: '#FFFFFF',
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
    fontSize: 18,
    fontWeight: '700',
    color: '#111111',
    flex: 1,
  },
  logoutButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    minHeight: 44,
    justifyContent: 'center',
  },
  logoutText: {
    fontSize: 15,
    color: '#B00020',
  },
  historyButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    minHeight: 44,
    justifyContent: 'center',
  },
  historyText: {
    fontSize: 15,
    color: '#0066CC',
    fontWeight: '600',
  },
  syncButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  syncText: {
    fontSize: 15,
    color: '#0066CC',
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
    color: '#888888',
    textAlign: 'center',
  },
  listContent: {
    padding: 16,
  },
  taskCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E8E8E8',
    padding: 16,
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
    color: '#111111',
    lineHeight: 22,
    marginRight: 10,
  },
  priorityBadge: {
    fontSize: 10,
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
    color: '#555555',
  },
  taskDeadline: {
    marginTop: 8,
    fontSize: 13,
    color: '#888888',
  },
  taskDescription: {
    marginTop: 6,
    fontSize: 14,
    color: '#666666',
    lineHeight: 20,
  },
});
