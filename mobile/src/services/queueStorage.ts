/**
 * oneTeam mobile field client — AsyncStorage, as a `QueueStorage`.
 * ============================================================================
 *
 * WHY THIS IS A SEPARATE FILE FROM THE POLICY
 * -------------------------------------------
 * Exactly the reason `keychain.ts` is separate from `credentialStore.ts`, and
 * the separation is what makes plan item 3.3 testable at all.
 *
 * `offlineQueue.ts` holds every rule worth testing: persist before reporting
 * success, refuse rather than evict at the limit, write the in-flight marker
 * before the upload, hold back an interrupted item instead of retrying it. This
 * file holds the one thing that cannot be exercised from a build machine — a
 * call into a native module.
 *
 * If the policy imported `@react-native-async-storage/async-storage`, every test
 * of it would need a device, and in practice that means it would not be tested.
 * That is not a hypothetical: it is precisely how `OfflineQueueManager` kept a
 * memory-only array for three phases while the README described it as durable.
 *
 * So: only the app entry imports this. Nothing else under `src/` may.
 *
 * WHY THIS IS NOT THE KEYCHAIN
 * ----------------------------
 * It is worth being explicit, because the queue holds evidence photos and it
 * would be easy to assume they belong in `expo-secure-store` too.
 *
 * They do not, for a reason that is about mechanics rather than importance. A
 * keychain entry is size-limited (a few kilobytes) and is designed for short
 * secrets; a queue of base64 shelf photographs is megabytes. The keychain is
 * for the credential, and the credential is small and long-lived. The queue is
 * large and short-lived — it exists to survive a tunnel, not a month.
 *
 * What that means in practice, and it is a real exposure rather than a
 * theoretical one: **AsyncStorage is not encrypted.** On iOS it is a file inside
 * the app's own container, which iOS protects with the device passcode and the
 * app sandbox, but it is readable by anything that can read that container — a
 * jailbroken device, or a full device backup that is not encrypted. So a queued
 * audit is protected by the app sandbox and not by a key, and the plan's
 * "queued securely in local storage" phrasing overstates it. Recorded in the
 * plan's debt table rather than repeated here as a claim.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not clear on uninstall — that is the operating system's behaviour for
 * the app container, and it is the opposite of the keychain's. Which is the
 * useful property here: uninstalling the app discards the queue and keeps the
 * identity, so a reinstall is the same device with no stale audits.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { QUEUE_STORAGE_KEY, QueueStorage } from './offlineQueue';

/**
 * The device's queue, in the app's container.
 *
 * One key holding the whole queue, matching the `QueueStorage` shape — see the
 * note there on why it is a single blob rather than a key per item.
 */
export const asyncStorageQueue: QueueStorage = {
  async read(): Promise<string | null> {
    return await AsyncStorage.getItem(QUEUE_STORAGE_KEY);
  },

  async write(serialized: string): Promise<void> {
    await AsyncStorage.setItem(QUEUE_STORAGE_KEY, serialized);
  },
};

/** The key the probe uses. Deliberately not the queue's own key. */
const PROBE_KEY = 'oneteam.queueStorageProbe';

/**
 * Whether this platform can hold the queue at all.
 *
 * A REAL round trip, not a capability flag. AsyncStorage has no
 * `isAvailableAsync` — unlike `expo-secure-store` — and the obvious substitute,
 * "the module imported successfully", answers a different question: on web the
 * module is present and backed by `localStorage`, which throws when storage is
 * disabled or the quota is exhausted. The app entry has to choose between the
 * persistent adapter and the memory fallback, and choosing wrong is silent
 * either way, so the check is the thing itself: write, read back, remove.
 *
 * The probe is removed on every path, including the failure paths, so a failed
 * check does not itself leave litter in the container. If the removal fails the
 * check still passes — a stray key is not a reason to declare storage unusable.
 */
export async function queueStorageAvailable(): Promise<boolean> {
  const token = `${Date.now()}`;
  try {
    await AsyncStorage.setItem(PROBE_KEY, token);
    const readBack = await AsyncStorage.getItem(PROBE_KEY);
    if (readBack !== token) return false;
    await AsyncStorage.removeItem(PROBE_KEY).catch(() => undefined);
    return true;
  } catch {
    // Reported as "no persistent queue" rather than thrown. The app still works
    // on the memory fallback; it simply cannot survive a restart, and the entry
    // screen says so.
    return false;
  }
}
