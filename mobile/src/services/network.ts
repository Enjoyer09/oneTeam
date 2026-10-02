/**
 * oneTeam mobile field client — connectivity, as a listener the queue can use.
 * ============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `OfflineQueueManager.setOnlineStatus` has always known how to drain on an
 * offline→online edge, and `triggerAutoSync` has always been ready to run. What
 * was missing was anything to *call* `setOnlineStatus` with a real reading: the
 * build shipped with no connectivity dependency, so the reconnection edge never
 * fired. `Root.tsx` said so in as many words, and leaned on a startup drain plus
 * a foreground drain as the only substitutes. That left the headline case —
 * "the worker walked out of the basement and the signal came back while the app
 * was open" — undetected until they next backgrounded and reopened the app.
 *
 * This file closes that gap. It is the connectivity counterpart to `keychain.ts`
 * and `queueStorage.ts`: the one place a native module (`expo-network`) is
 * touched, kept out of the policy under `src/services/` so that policy still
 * runs under Node. Only the app entry (`Root.tsx`) imports it.
 *
 * WHAT "ONLINE" MEANS HERE
 * -----------------------
 * `isConnected` alone can be true on a captive portal or a connected-but-dead
 * link, and draining then just burns retries against uploads that cannot land.
 * So online requires `isConnected === true` AND `isInternetReachable` not false.
 * On iOS `isInternetReachable` mirrors `isConnected`, so this is exactly
 * `isConnected` there; the extra clause is what keeps the reading honest if this
 * ever runs on Android.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not drain, and it does not know the queue exists. It reports a boolean
 * and lets `Root.tsx` hand it to `setOnlineStatus`, for the same reason the queue
 * takes an injected upload handler: connectivity is about the radio, draining is
 * about the queue, and tangling the two would make either impossible to reason
 * about on its own.
 */

import * as Network from 'expo-network';

/**
 * Collapses a `NetworkState` to the single boolean the queue cares about.
 *
 * See the header on why both fields are required rather than just `isConnected`.
 */
function isOnline(state: Network.NetworkState): boolean {
  return state.isConnected === true && state.isInternetReachable !== false;
}

/**
 * Whether this platform can report connectivity at all.
 *
 * A real reading, not a "did the import succeed" flag — the same stance as
 * `queueStorageAvailable`. A single `getNetworkStateAsync` that resolves is proof
 * the module answers; anything else is reported as "no connectivity signal" so
 * the caller falls back to the startup/foreground/manual drains rather than
 * wiring a listener that will never fire.
 */
export async function networkAvailable(): Promise<boolean> {
  try {
    await Network.getNetworkStateAsync();
    return true;
  } catch {
    return false;
  }
}

/**
 * The current online reading, taken once.
 *
 * `Root.tsx` seeds the queue with this at startup so `getOnlineStatus()` is
 * accurate before any capture — the queue defaults to "online", and a worker who
 * opens the app already in a dead zone would otherwise have their first audit
 * attempt an upload instead of being queued. On any error it reports `false`:
 * assuming offline is the safe direction, because it queues rather than throwing
 * an audit at a link that is not there.
 */
export async function getCurrentOnlineStatus(): Promise<boolean> {
  try {
    return isOnline(await Network.getNetworkStateAsync());
  } catch {
    return false;
  }
}

/**
 * Subscribes to connectivity changes, reporting each as an online/offline
 * boolean. Returns an unsubscribe function.
 *
 * The listener is the whole point of the file: it is what finally drives
 * `setOnlineStatus`, so the offline→online edge fires while the app is open and
 * the queue drains without waiting for a foreground or a button press.
 */
export function subscribeToConnectivity(onChange: (online: boolean) => void): () => void {
  const subscription = Network.addNetworkStateListener((state) => {
    onChange(isOnline(state));
  });
  return () => {
    subscription.remove();
  };
}
