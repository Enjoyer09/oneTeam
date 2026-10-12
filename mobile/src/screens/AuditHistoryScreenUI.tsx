/**
 * oneTeam mobile — Audit History screen (React Native UI)
 * ============================================================================
 *
 * WHAT THIS IS
 * ------------
 * The screen a field worker opens from the task list to see the audits they
 * have filed and — the part that matters — the ones still waiting in the
 * offline queue, with each item's sync status and the reason it is stuck.
 *
 * WHY IT HAD TO EXIST
 * -------------------
 * `AuditHistoryController.getAuditHistory` was written and then never shown:
 * nothing routed to a history screen, so a queued audit that failed, or one the
 * app held back after an interrupted send, was invisible. The only feedback was
 * an aggregate count badge. A worker could not tell a stuck audit from a sent
 * one, nor do anything about it. This screen is that missing window, with a
 * per-item resend (drains the whole queue) and discard.
 *
 * Reads through `mobileApp.history` — the one controller instance that also
 * registered the queue's upload handler — rather than constructing its own, so
 * the drain path stays single-sourced.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MobileStore, MobileSubmission, QueueItem } from '../types';
import { mobileApp } from '../App';

export interface AuditHistoryScreenProps {
  store: MobileStore;
  onBack: () => void;
}

const SUBMISSION_STATUS_LABEL: Record<string, string> = {
  pending_review: 'Yoxlanılır',
  approved: 'Təsdiqləndi',
  rejected: 'İmtina edildi',
};

const SYNC_STATUS_LABEL: Record<string, string> = {
  queued: 'Növbədə',
  syncing: 'Göndərilir…',
  failed: 'Alınmadı',
  synced: 'Göndərildi',
};

function shortTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('az-AZ');
}

export function AuditHistoryScreenUI({ store, onBack }: AuditHistoryScreenProps) {
  const insets = useSafeAreaInsets();
  const controller = mobileApp.history;
  const [submissions, setSubmissions] = useState<MobileSubmission[]>([]);
  const [queued, setQueued] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await controller.getAuditHistory(store.id);
      setSubmissions(data.submissions);
      setQueued(data.queuedItems);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [controller, store.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSyncAll = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await controller.triggerManualSync();
      setNotice(
        `Göndərildi: ${result.syncedCount}` +
          (result.failedCount ? `, alınmadı: ${result.failedCount}` : ''),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const handleDiscard = (item: QueueItem) => {
    Alert.alert(
      'Audit silinsin?',
      'Bu göndərilməmiş audit növbədən silinəcək. Bu geri qaytarıla bilməz.',
      [
        { text: 'İmtina', style: 'cancel' },
        {
          text: 'Sil',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusy(true);
              try {
                await controller.discardQueuedAudit(item.id);
                setNotice('Audit növbədən silindi.');
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
                await load();
              }
            })();
          },
        },
      ],
    );
  };

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator size="large" color="#0066CC" />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <TouchableOpacity
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Geri"
          style={styles.backButton}
        >
          <Text style={styles.backText}>‹ Geri</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          Tarixçə
        </Text>
        <TouchableOpacity
          onPress={() => void handleSyncAll()}
          disabled={busy || queued.length === 0}
          accessibilityRole="button"
          accessibilityLabel="Növbədəki auditləri göndər"
          style={styles.syncButton}
        >
          {busy ? (
            <ActivityIndicator size="small" color="#0066CC" />
          ) : (
            <Text style={[styles.syncText, queued.length === 0 && styles.syncTextDisabled]}>
              Hamısını göndər
            </Text>
          )}
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={[styles.banner, styles.bannerError]}>
          <Text style={styles.bannerErrorText}>{error}</Text>
        </View>
      ) : notice ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{notice}</Text>
        </View>
      ) : null}

      <FlatList
        data={queued}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load();
            }}
          />
        }
        ListHeaderComponent={
          <Text style={styles.sectionTitle}>
            Göndərilməmiş növbə{queued.length > 0 ? ` (${queued.length})` : ''}
          </Text>
        }
        ListEmptyComponent={<Text style={styles.empty}>Göndərilməmiş audit yoxdur.</Text>}
        renderItem={({ item }) => (
          <View style={styles.card} testID="history.queueItem">
            <View style={styles.cardRow}>
              <Text style={styles.cardTitle} numberOfLines={1}>
                {item.task_id}
              </Text>
              <Text style={[styles.badge, badgeStyleFor(item.sync_status)]}>
                {SYNC_STATUS_LABEL[item.sync_status] ?? item.sync_status}
              </Text>
            </View>
            <Text style={styles.cardMeta}>
              {shortTime(item.created_at)}
              {item.retry_count > 0 ? ` · ${item.retry_count} cəhd` : ''}
            </Text>
            {item.error_message ? <Text style={styles.cardError}>{item.error_message}</Text> : null}
            <TouchableOpacity
              onPress={() => handleDiscard(item)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Bu auditi sil"
              style={styles.discardButton}
            >
              <Text style={styles.discardText}>Sil</Text>
            </TouchableOpacity>
          </View>
        )}
        ListFooterComponent={
          <View>
            <Text style={styles.sectionTitle}>
              Göndərilmiş auditlər{submissions.length > 0 ? ` (${submissions.length})` : ''}
            </Text>
            {submissions.length === 0 ? (
              <Text style={styles.empty}>Hələ göndərilmiş audit yoxdur.</Text>
            ) : (
              submissions.map((sub) => (
                <View key={sub.id} style={styles.card} testID="history.submissionItem">
                  <View style={styles.cardRow}>
                    <Text style={styles.cardTitle} numberOfLines={1}>
                      {sub.task_id}
                    </Text>
                    <Text style={[styles.badge, badgeStyleFor(sub.status)]}>
                      {SUBMISSION_STATUS_LABEL[sub.status] ?? sub.status}
                    </Text>
                  </View>
                  <Text style={styles.cardMeta}>{shortTime(sub.submitted_at)}</Text>
                  {sub.reviewer_feedback ? (
                    <Text style={styles.cardFeedback}>{sub.reviewer_feedback}</Text>
                  ) : null}
                </View>
              ))
            )}
          </View>
        }
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
}

function badgeStyleFor(status: string) {
  if (status === 'approved' || status === 'synced') return styles.badgeOk;
  if (status === 'rejected' || status === 'failed') return styles.badgeBad;
  return styles.badgeNeutral;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFFFFF' },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E0E0E0',
  },
  backButton: { paddingRight: 12, minHeight: 44, justifyContent: 'center' },
  backText: { fontSize: 15, color: '#0066CC', fontWeight: '600' },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', color: '#111111' },
  syncButton: {
    paddingHorizontal: 12,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  syncText: { fontSize: 15, color: '#0066CC', fontWeight: '600' },
  syncTextDisabled: { color: '#9AA0A6' },
  banner: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#F0F6FF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#D6E4FF',
  },
  bannerText: { fontSize: 13, color: '#0066CC' },
  bannerError: { backgroundColor: '#FDECEE', borderBottomColor: '#F5C2C7' },
  bannerErrorText: { fontSize: 13, color: '#B00020' },
  listContent: { padding: 16, paddingBottom: 32 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#5D6C86',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 8,
  },
  empty: { fontSize: 14, color: '#9AA0A6', paddingVertical: 12 },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E0E0E0',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    backgroundColor: '#FAFAFA',
  },
  cardRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: '#111111', marginRight: 8 },
  cardMeta: { fontSize: 12, color: '#5D6C86', marginTop: 4 },
  cardError: { fontSize: 13, color: '#B00020', marginTop: 6 },
  cardFeedback: { fontSize: 13, color: '#33425E', marginTop: 6 },
  badge: {
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: 'hidden',
  },
  badgeOk: { backgroundColor: '#E3F6EC', color: '#1C7A4F' },
  badgeBad: { backgroundColor: '#FDECEE', color: '#B00020' },
  badgeNeutral: { backgroundColor: '#EEF1F5', color: '#5D6C86' },
  discardButton: {
    alignSelf: 'flex-start',
    marginTop: 10,
    paddingHorizontal: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  discardText: { fontSize: 14, color: '#B00020', fontWeight: '600' },
});
