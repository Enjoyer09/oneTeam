/**
 * oneTeam mobile field client — the iOS keychain, as a `SecureKeyValueStore`.
 * ============================================================================
 *
 * WHY THIS IS A SEPARATE FILE FROM THE POLICY
 * -------------------------------------------
 * `credentialStore.ts` holds every rule worth testing — mint once, persist
 * before use, replace on enrolment, keep the identity when the credential is
 * cleared. This file holds the one thing that cannot be tested from a build
 * machine: a call into a native keychain.
 *
 * Keeping them apart is what lets the policy run under Node. If the policy
 * imported `expo-secure-store`, every test of it would need a phone, and in
 * practice that means it would not be tested at all — which is how the
 * `demo-device-01` default survived this long.
 *
 * So: only the app entry imports this. Nothing under `src/services/` may.
 *
 * WHY `WHEN_UNLOCKED_THIS_DEVICE_ONLY`
 * ------------------------------------
 * A device credential is worth one installation and the API refuses it if it
 * names a different one, so syncing it to a second device can only ever produce
 * a credential that fails. `ThisDeviceOnly` keeps it out of iCloud Keychain
 * backups. The alternative, the default `WHEN_UNLOCKED`, would copy the
 * credential to every device the user restores from a backup — and because the
 * API allows one live token per `device_id`, the restored copy would revoke the
 * original. A restore would then look like the original phone being signed out.
 *
 * `WHEN_UNLOCKED` rather than `ALWAYS`: this app is only used with the screen
 * on, and the weaker class would let a locked device be read.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not clear anything on uninstall, and it cannot: on iOS the keychain is
 * not scoped to the app bundle, so a reinstall keeps the entry and the device
 * stays enrolled. That is the behaviour the plan asks for ("the device token
 * survives a delete"), and it is a real trade-off worth naming — a phone that is
 * handed on carries the previous worker's identity.
 *
 * WHICH IS WORSE THAN IT SOUNDS, BECAUSE NOTHING CAN CUT THE DEVICE OFF
 * --------------------------------------------------------------------
 * Checked against the API rather than assumed, after a first draft of this
 * comment named a revoke route that does not exist. `panel-auth.controller.ts`
 * has `keys/:prefix/revoke` and `users/:userId/revoke-keys`, and both of those
 * are for PANEL keys. There is no route anywhere that revokes a DEVICE token.
 *
 * The two ways a device credential can be invalidated today, and what each
 * costs:
 *
 *   - The device enrols again, which revokes its previous live token as it
 *     issues a new one (`insertDeviceToken`). That requires the phone, so it is
 *     no use for a phone that is gone.
 *   - The user is deleted, which cascades to their tokens
 *     (`device_tokens.user_id ... ON DELETE CASCADE`). But a user with audits
 *     cannot be deleted at all — `DELETE /api/panel/users/:id` answers
 *     `409 USER_HAS_SUBMISSIONS` — and a merchandiser who has filed an audit is
 *     exactly the one whose phone you would want to cut off.
 *
 * So a lost phone holding a live credential cannot be shut out from the panel.
 * That is a gap in the API, not in this file, and it is recorded in the plan's
 * debt table rather than papered over here.
 */

import * as SecureStore from 'expo-secure-store';

import type { SecureKeyValueStore } from './credentialStore';

/**
 * Options applied to every read and write.
 *
 * The service name is pinned so the entries are grouped under one keychain
 * service rather than the default bundle-id one, which makes them findable and
 * removable as a set during an incident.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: 'az.oneteam.cocacola.fieldaudit.credentials',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const keychainStore: SecureKeyValueStore = {
  async get(key: string): Promise<string | null> {
    return SecureStore.getItemAsync(key, OPTIONS);
  },

  async set(key: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(key, value, OPTIONS);
  },

  async remove(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(key, OPTIONS);
  },
};

/**
 * Whether this platform can hold a credential at all.
 *
 * False on a simulator without a keychain, on some managed devices, and on
 * web. Callers must not treat that as fatal — `MemorySecureStore` is the
 * fallback and the app works, it simply enrols again next launch. Reporting the
 * truth beats a silent downgrade that nobody notices until an audit.
 */
export async function keychainAvailable(): Promise<boolean> {
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}
