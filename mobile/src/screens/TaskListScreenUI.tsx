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
import { TaskListController } from './TaskListScreen';

export interface TaskListScreenProps {
  store: MobileStore;
  onSelectTask: (task: MobileTask) => void;
  onLogout: () => void;
}

export function TaskListScreenUI({ store, onSelectTask, onLogout }: TaskListScreenProps) {
  const controller = new TaskListController();
  const [tasks, setTasks] = useState<MobileTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    }
  };

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
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{store.name}</Text>
        <TouchableOpacity onPress={onLogout} style={styles.logoutButton}>
          <Text style={styles.logoutText}>Çıxış</Text>
        </TouchableOpacity>
      </View>

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
          contentContainerStyle={styles.listContent}
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
    <TouchableOpacity style={styles.taskCard} onPress={onPress} activeOpacity={0.7}>
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
    paddingTop: 60,
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
  },
  logoutText: {
    fontSize: 15,
    color: '#B00020',
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
    paddingBottom: 34,
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
