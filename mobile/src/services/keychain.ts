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
 * HOW A LOST PHONE IS CUT OFF
 * ---------------------------
 * Checked against the API rather than assumed. An earlier draft of this comment
 * said no route could revoke a device token and called it an API gap — that is
 * no longer true, and the note is corrected here rather than left to mislead.
 *
 * A device credential can be invalidated three ways today:
 *
 *   - A supervisor revokes it from the panel, WITHOUT the phone. This is the one
 *     that matters for a lost phone. `GET /api/panel/.../devices` lists every
 *     device by `deviceId` (`panel-auth.controller.ts` → `db.listDeviceTokens`),
 *     and `POST /api/panel/.../devices/:deviceId/revoke` cuts it off
 *     (`revokeDeviceTokensForDevice` → `UPDATE device_tokens SET revoked_at`).
 *     It is scoped to supervisors and above, and it revokes by `deviceId`
 *     because "the phone was lost" is a fact about a device, not a person — the
 *     same merchandiser may still hold a working second phone.
 *   - The device enrols again, which revokes its previous live token as it
 *     issues a new one (`insertDeviceToken`). Useful for a handed-on phone that
 *     is present; no use for one that is gone.
 *   - The user is deleted, which cascades to their tokens. But a user with
 *     audits cannot be deleted — `DELETE /api/panel/users/:id` answers
 *     `409 USER_HAS_SUBMISSIONS` — so this is not the path for an active
 *     merchandiser; the panel revoke route above is.
 *
 * Revocation bites immediately: `findDeviceToken` matches only `revoked_at IS
 * NULL`, so the auth guard rejects a revoked token on the very next request, and
 * `device_tokens` has no in-memory replica for a stale copy to survive in. The
 * residual trade-off is unchanged and real — the keychain still survives
 * uninstall, so a handed-on phone carries the previous worker's identity UNTIL a
 * supervisor revokes that `deviceId`.
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
