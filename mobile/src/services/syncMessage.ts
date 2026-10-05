/**
 * oneTeam mobile — what a field worker is told after pressing sync
 * ============================================================================
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * This copy is the last thing a merchandiser reads before deciding their queued
 * audits are safe. It lives here rather than inside `TaskListScreenUI.tsx` so it
 * can be tested directly: the screen imports `react-native` and
 * `react-native-safe-area-context`, neither of which exists outside a device, so
 * anything co-located with it is untestable.
 *
 * THE BUG IT ENCODES
 * ------------------
 * `OfflineQueueManager.drainQueue` returns three counts, not two:
 *
 *     syncedCount    uploads that landed
 *     failedCount    uploads that failed and may be retried
 *     skippedCount   items that hit MAX_RETRY_ATTEMPTS and are dead-lettered
 *
 * The copy used to branch only on `syncedCount` and `failedCount`, ignoring
 * `skippedCount`. Verified against the pre-fix logic:
 *
 *     {synced: 0, failed: 0, skipped: 2}  ->  "Sinxronizasiya tamamlandı."
 *     {synced: 3, failed: 0, skipped: 1}  ->  "✅ 3 audit göndərildi."
 *
 * Both are lies. In each case audits were still unsent, no longer retried
 * automatically, and would never reach a supervisor unless the worker noticed —
 * and the app had just said everything was fine. Nothing was lost, so this was
 * never data loss; it was the app telling a worker to stop checking on work it
 * still owed.
 *
 * Guarded by `tests/syncMessage.test.ts`.
 */

export interface SyncCounts {
  syncedCount: number;
  failedCount: number;
  skippedCount: number;
  reason?: string;
}

export function buildSyncMessage(result: SyncCounts, hasStrandedItems: boolean): string {
  const { syncedCount, failedCount, skippedCount } = result;

  // Anything stranded wins, and it is checked FIRST because one drain can report
  // syncedCount > 0 and stranded items at the same time — which is exactly the
  // case the old success branch swallowed.
  if (skippedCount > 0 || hasStrandedItems) {
    const stuck = skippedCount > 0 ? skippedCount : 1;
    const parts: string[] = [];
    if (syncedCount > 0) parts.push(`${syncedCount} göndərildi`);
    parts.push(
      `${stuck} audit avtomatik cəhdlərdən çıxarıldı və hələ də göndərilməyib — ` +
        `siyahıdan yığın və ya əl ilə göndərin.`,
    );
    return parts.join('; ');
  }

  if (syncedCount > 0 && failedCount === 0) {
    return `✅ ${syncedCount} audit göndərildi.`;
  }

  if (result.reason === 'nothing-pending') {
    return 'Göndəriləcək audit yoxdur.';
  }

  if (failedCount > 0) {
    return `${syncedCount} göndərildi, ${failedCount} alınmadı — sonra yenidən cəhd edin.`;
  }

  return 'Sinxronizasiya tamamlandı.';
}
