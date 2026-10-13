import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { mobileApp } from '../App';
import { mobileApi } from '../services/portalApi';
import { offlineQueueService } from '../services/offlineQueue';
import { buildSyncMessage } from '../services/syncMessage';
import { palette, spacing, typography } from '../theme';
import type { MobileStore, MobileSubmission, QueueItem } from '../types';

const statuses = {
  pending_review: 'Yoxlama gözləyir',
  approved: 'Təsdiqləndi',
  rejected: 'Düzəliş tələb olunur',
};
const queueStatuses = {
  queued: 'Cihazda saxlanılıb',
  syncing: 'Göndərilir…',
  failed: 'Göndərilmədi',
  synced: 'Göndərildi',
};
const dateLabel = (date: string) =>
  new Date(date).toLocaleString('az-AZ', { timeZone: 'Asia/Baku' });

export function AuditHistoryScreenUI({
  store,
  onBack,
}: {
  store: MobileStore;
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [submissions, setSubmissions] = useState<MobileSubmission[]>([]);
  const [queued, setQueued] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const refreshQueue = useCallback(() => {
    try {
      setQueued(
        offlineQueueService
          .getQueue()
          .filter((item) => item.store_id === store.id && item.sync_status !== 'synced'),
      );
      setQueueError(null);
    } catch {
      setQueueError('Cihazdakı növbə oxuna bilmədi.');
    }
  }, [store.id]);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    refreshQueue();
    try {
      setSubmissions(await mobileApi.getSubmissionsForStore(store.id));
    } catch {
      setError('Göndərilən auditlər yenilənmədi. Bağlantını yoxlayıb yenidən cəhd edin.');
    } finally {
      setLoading(false);
    }
  }, [store.id, refreshQueue]);
  useEffect(() => {
    void load();
    const unsubscribe = offlineQueueService.subscribe(() => {
      refreshQueue();
      void load();
    });
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') void load();
    });
    return () => {
      unsubscribe();
      foreground.remove();
    };
  }, [load, refreshQueue]);
  const sync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const result = await mobileApp.history.triggerManualSync();
      setMessage(buildSyncMessage(result, offlineQueueService.getPendingCount() > 0));
      await load();
    } catch {
      setMessage('Göndərmə alınmadı. Auditlər cihazda saxlanılır.');
    } finally {
      setSyncing(false);
    }
  };
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" onPress={onBack} style={styles.button}>
          <Text style={styles.link}>← Tapşırıqlar</Text>
        </TouchableOpacity>
        <Text accessibilityRole="header" style={styles.title}>
          Auditlərim
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }}>
        <Text style={styles.body}>{store.name}</Text>
        <Text style={styles.title}>Cihazdakı növbə ({queueError ? '—' : queued.length})</Text>
        {queueError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {queueError}
          </Text>
        ) : null}
        {!queueError && queued.length === 0 ? (
          <Text style={styles.body}>Göndərilməyi gözləyən audit yoxdur.</Text>
        ) : null}
        {queued.map((item) => (
          <View key={item.id} style={styles.card}>
            <Text style={styles.label}>{queueStatuses[item.sync_status]}</Text>
            <Text style={styles.body}>
              {typeof item.metadata.task_title === 'string'
                ? item.metadata.task_title
                : `Audit #${item.id.slice(-6)}`}
            </Text>
            <Text style={styles.body}>{dateLabel(item.created_at)}</Text>
            {item.error_message ? <Text style={styles.error}>{item.error_message}</Text> : null}
          </View>
        ))}
        {queued.length > 0 ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ disabled: syncing }}
            disabled={syncing}
            onPress={() => void sync()}
            style={styles.button}
          >
            <Text style={styles.link}>{syncing ? 'Göndərilir…' : 'Növbəni yenidən göndər'}</Text>
          </TouchableOpacity>
        ) : null}
        {message ? (
          <Text accessibilityLiveRegion="polite" style={styles.body}>
            {message}
          </Text>
        ) : null}
        <Text style={styles.title}>Göndərilən auditlər</Text>
        <TouchableOpacity
          accessibilityRole="button"
          disabled={loading}
          onPress={() => void load()}
          style={styles.button}
        >
          <Text style={styles.link}>Yenilə</Text>
        </TouchableOpacity>
        {loading ? <ActivityIndicator accessibilityLabel="Auditlər yüklənir" /> : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {!loading && !error && submissions.length === 0 ? (
          <Text style={styles.body}>Hələ audit göndərilməyib.</Text>
        ) : null}
        {submissions.map((item) => (
          <View key={item.id} style={styles.card}>
            <Text style={styles.label}>{statuses[item.status] ?? 'Vəziyyət yenilənir'}</Text>
            <Text style={styles.body}>{dateLabel(item.submitted_at)}</Text>
            <Text style={styles.body}>
              {typeof item.metadata.task_title === 'string'
                ? item.metadata.task_title
                : `Audit #${item.id.slice(-6)}`}
            </Text>
            {item.reviewer_feedback ? (
              <Text style={styles.body}>Nəzarətçinin rəyi: {item.reviewer_feedback}</Text>
            ) : null}
            {item.status === 'rejected' ? (
              <TouchableOpacity accessibilityRole="button" onPress={onBack} style={styles.button}>
                <Text style={styles.link}>Düzəliş üçün tapşırıqlara qayıt</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  header: {
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  title: { fontSize: typography.title, fontWeight: '700', color: palette.text, marginVertical: 12 },
  body: { fontSize: typography.body, color: palette.textSecondary, marginVertical: 4 },
  label: { fontSize: typography.body, fontWeight: '600', color: palette.text },
  link: { fontSize: typography.body, color: palette.focus, fontWeight: '600' },
  button: { minHeight: 44, justifyContent: 'center', paddingVertical: 10 },
  card: {
    padding: spacing.md,
    marginVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
  },
  error: { color: palette.danger, fontSize: typography.body, marginVertical: 8 },
});
