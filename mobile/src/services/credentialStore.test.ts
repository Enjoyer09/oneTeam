/**
 * oneTeam mobile field client — credential policy verification
 * ============================================================================
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * The rest of the mobile app needs a phone, a camera and a running API. This
 * policy needs none of them, and that is exactly why it was the part that stayed
 * broken: `deviceId()` fell back to the literal `demo-device-01`, so every
 * unconfigured installation was the same device — sharing one user row and one
 * audit history, and revoking each other's credentials on every sign-in, because
 * the API permits one live token per `device_id`.
 *
 * So this suite drives the policy directly, with an in-memory store standing in
 * for the keychain. Every rule here is one the device depends on:
 *
 *   - the identity is minted ONCE and survives a restart;
 *   - two installations get DIFFERENT identities (the defect above);
 *   - the credential is persisted before it is used, and replaced on every
 *     enrolment, because the API revokes the previous one as it issues the new;
 *   - clearing local data keeps the credential AND the identity;
 *   - `portalApi.deviceId()` refuses to invent an identity;
 *   - the harness overlay (`ONETEAM_DEVICE_ID`) names the process without
 *     overwriting the installation's own identity.
 *
 * WHAT IT CANNOT TELL YOU
 * -----------------------
 * That the iOS keychain works. `keychain.ts` is not imported here — it cannot be,
 * it calls a native module — so this suite proves the policy, not the storage
 * underneath it. Nothing here has been run on a device.
 *
 * Run with: `npm run test:credentials`
 */

import {
  CredentialStore,
  DEVICE_ID_KEY,
  MemorySecureStore,
  credentialStore,
  mintDeviceId,
} from './credentialStore';
import type { SecureKeyValueStore } from './credentialStore';
import {
  currentDeviceId,
  deviceId,
  forgetCredential,
  hasDeviceToken,
  restoreCredential,
} from './portalApi';
import { mobileApp } from '../App';
import { offlineQueueService } from '../services/offlineQueue';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
};

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  ${colors.green}✅ [PASS]${colors.reset} ${label}`);
  } else {
    failed++;
    console.log(`  ${colors.red}❌ [FAIL]${colors.reset} ${label}`);
    if (detail !== undefined) {
      console.log(
        `         ${colors.yellow}got:${colors.reset} ${JSON.stringify(detail)?.slice(0, 400)}`,
      );
    }
  }
}

function section(title: string) {
  console.log(`\n${colors.cyan}${colors.bright}${title}${colors.reset}`);
}

/** A store that records how many writes it saw, so "minted once" is provable. */
class CountingStore implements SecureKeyValueStore {
  private readonly inner = new MemorySecureStore();
  public writes = 0;
  public reads = 0;

  async get(key: string): Promise<string | null> {
    this.reads++;
    return this.inner.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.writes++;
    await this.inner.set(key, value);
  }

  async remove(key: string): Promise<void> {
    await this.inner.remove(key);
  }
}

/** A store whose first read fails, to prove a failure is not cached. */
class FlakyStore implements SecureKeyValueStore {
  private readonly inner = new MemorySecureStore();
  private failuresLeft = 1;

  async get(key: string): Promise<string | null> {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error('keychain unavailable');
    }
    return this.inner.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.inner.set(key, value);
  }

  async remove(key: string): Promise<void> {
    await this.inner.remove(key);
  }
}

/**
 * A restart, as far as storage is concerned: a NEW store over the same backing
 * store.
 *
 * Needed because `CredentialStore.deviceId()` caches its answer, so asking the
 * SAME instance whether the identity survived a clear answers from memory and
 * says yes even when storage has lost it. That is not a hypothetical: this suite
 * was written with exactly that mistake, and the break-the-detector run found it
 * — reverting `clearDeviceToken` so that it destroyed the identity as well left
 * the suite at 34/34 green, because every assertion about the identity surviving
 * was asking the instance that already knew the answer.
 *
 * The failure being guarded is a device that discovers the loss on its NEXT
 * LAUNCH, so the question has to be asked of a process that has just started.
 */
function restartOf(storage: SecureKeyValueStore): CredentialStore {
  return new CredentialStore(storage);
}

async function main() {
  console.log(`${colors.bright}oneTeam mobile — credential policy${colors.reset}`);
  console.log(`${colors.cyan}${'─'.repeat(74)}${colors.reset}`);

  // -------------------------------------------------------------------------
  // ORDER IS LOAD-BEARING — this must run before anything restores a credential.
  //
  // `restoreCredential()` is what puts an identity into `portalApi`, and there
  // is no way back to the "nothing restored" state afterwards, because the value
  // it sets is the installation's identity and it is meant to be fixed for the
  // life of the process. These checks assert the refusal that the
  // `demo-device-01` default used to paper over, so they have to go first. A
  // test that quietly stopped exercising the refusal because of ordering would
  // be worse than no test at all.
  // -------------------------------------------------------------------------
  section('0. Before the credential is read — the refusal that replaced a default');

  const savedEnvId = process.env.ONETEAM_DEVICE_ID;
  delete process.env.ONETEAM_DEVICE_ID;

  let threw: string | null = null;
  try {
    check(
      'currentDeviceId() is null rather than a made-up value',
      currentDeviceId() === null,
      currentDeviceId(),
    );
    try {
      deviceId();
    } catch (error) {
      threw = error instanceof Error ? ((error as { code?: string }).code ?? error.message) : 'x';
    }
  } catch (error) {
    threw = `unexpected failure: ${String(error)}`;
  }

  check(
    'deviceId() refuses instead of returning a shared default',
    threw === 'DEVICE_ID_NOT_RESTORED',
    threw,
  );

  if (savedEnvId !== undefined) process.env.ONETEAM_DEVICE_ID = savedEnvId;

  // -------------------------------------------------------------------------
  section('1. The installation identity is minted once and never changes');

  const storeA = new CountingStore();
  const first = new CredentialStore(storeA);

  const mintedId = await first.deviceId();
  check(
    'an identity is produced on first use',
    typeof mintedId === 'string' && mintedId.length > 8,
    mintedId,
  );
  check('it is written to storage, not only held in memory', storeA.writes === 1, storeA.writes);

  const second = new CredentialStore(storeA);
  const afterRestart = await second.deviceId();
  check(
    'a new process reads the SAME identity back (a restart keeps the device)',
    afterRestart === mintedId,
    { afterRestart, mintedId },
  );
  check('and it did not mint a second one', storeA.writes === 1, storeA.writes);

  // The defect this file exists for: every unconfigured installation was
  // `demo-device-01`, and the API allows one live token per device id, so each
  // sign-in revoked the previous one.
  const storeB = new CountingStore();
  const otherInstallation = new CredentialStore(storeB);
  const otherId = await otherInstallation.deviceId();
  check(
    'two installations get DIFFERENT identities — the demo-device-01 defect',
    otherId !== mintedId,
    { otherId, mintedId },
  );

  // Two concurrent callers on a cold start. Caching the resolved value instead
  // of the promise would let both miss the cache and mint an identity each,
  // leaving one in storage and the other in memory.
  const storeC = new CountingStore();
  const racing = new CredentialStore(storeC);
  const [race1, race2, race3] = await Promise.all([
    racing.deviceId(),
    racing.deviceId(),
    racing.deviceId(),
  ]);
  check('concurrent callers all receive one identity', race1 === race2 && race2 === race3, {
    race1,
    race2,
    race3,
  });
  check('and only one write reached storage', storeC.writes === 1, storeC.writes);

  const flaky = new CredentialStore(new FlakyStore());
  let firstReadFailed = false;
  try {
    await flaky.deviceId();
  } catch {
    firstReadFailed = true;
  }
  const recovered = await flaky.deviceId().catch(() => null);
  check(
    'a storage failure is NOT cached — the next call retries and succeeds',
    firstReadFailed && typeof recovered === 'string' && recovered.length > 8,
    { firstReadFailed, recovered },
  );

  check(
    'minted ids are distinguishable in shape and content',
    mintDeviceId() !== mintDeviceId() && mintDeviceId().startsWith('dev-'),
    mintDeviceId(),
  );

  // -------------------------------------------------------------------------
  section('2. The credential is stored, replaced, and clearable on its own');

  const tokenStore = new MemorySecureStore();
  const creds = new CredentialStore(tokenStore);

  check('a fresh installation holds no credential', (await creds.deviceToken()) === null);

  await creds.saveDeviceToken('otd_first-token-value');
  check('a saved credential reads back', (await creds.deviceToken()) === 'otd_first-token-value');

  const restarted = new CredentialStore(tokenStore);
  check(
    'a restart sees the stored credential',
    (await restarted.deviceToken()) === 'otd_first-token-value',
  );

  // The API revokes the previous live token as it issues a new one, so a device
  // that keeps the old value holds a credential that has already stopped working.
  await creds.saveDeviceToken('otd_second-token-value');
  check(
    'a new enrolment REPLACES the stored credential',
    (await creds.deviceToken()) === 'otd_second-token-value',
  );

  let emptyRefused = false;
  try {
    await creds.saveDeviceToken('   ');
  } catch {
    emptyRefused = true;
  }
  check(
    'an empty credential is refused — "enrolled" with nothing to send is worse than not enrolled',
    emptyRefused && (await creds.deviceToken()) === 'otd_second-token-value',
    await creds.deviceToken(),
  );

  const identityBeforeClear = await creds.deviceId();
  await creds.clearDeviceToken();
  check('clearing the credential removes it', (await creds.deviceToken()) === null);
  check(
    'and KEEPS the identity in this process, so the next enrolment is the same device',
    (await creds.deviceId()) === identityBeforeClear,
    { identityBeforeClear, now: await creds.deviceId() },
  );

  // Asked of a fresh instance, because the one above answers from its cache. See
  // `restartOf` — an earlier version of this file only asked the cached one, and
  // went green when `clearDeviceToken` was broken to destroy the identity too.
  const restartedAfterClear = restartOf(tokenStore);
  const idAfterRestart = await restartedAfterClear.deviceId();
  check(
    'and KEEPS it in STORAGE, so a restart after clearing is still the same device',
    idAfterRestart === identityBeforeClear,
    { identityBeforeClear, idAfterRestart },
  );

  await creds.saveEnrollmentSecret('deployment-second-factor');
  check(
    'the enrolment secret round-trips',
    (await creds.enrollmentSecret()) === 'deployment-second-factor',
  );

  const snapshot = await creds.snapshot();
  check(
    'the snapshot reports presence without revealing either secret',
    snapshot.hasToken === false &&
      snapshot.hasEnrollmentSecret === true &&
      !JSON.stringify(snapshot).includes('deployment-second-factor'),
    snapshot,
  );

  // -------------------------------------------------------------------------
  section('3. Clearing local data keeps the credential — the stated rule');

  // Driven through the coordinator, not through the queue directly, because the
  // rule is about the ONE place that clears local state. Calling
  // `clearQueue()` here would prove only that two unrelated modules are
  // unrelated.
  //
  // `clearLocalData` became async in 3.3, when the queue moved onto the device:
  // clearing only the in-memory array would bring every item back next launch,
  // so the clear has to await the write. The count it returns comes back from
  // the same call that did the clearing.
  const liveStore = new MemorySecureStore();
  const liveCreds = new CredentialStore(liveStore);
  await liveCreds.saveDeviceToken('otd_live-token');
  const liveId = await liveCreds.deviceId();

  // The coordinator's own store is the module singleton, so point it at this
  // test's storage rather than the process default.
  credentialStore.useStorage(liveStore);

  await offlineQueueService.enqueueSubmission({
    taskId: 'task-for-clear-test',
    storeId: 'store-for-clear-test',
    photoUri: 'file:///tmp/shelf.jpg',
    metadata: { gps: { latitude: 40.38, longitude: 49.81 } } as never,
  });
  await offlineQueueService.enqueueSubmission({
    taskId: 'task-for-clear-test-2',
    storeId: 'store-for-clear-test',
    photoUri: 'file:///tmp/shelf-2.jpg',
    metadata: { gps: { latitude: 40.38, longitude: 49.81 } } as never,
  });

  check(
    'the queue really has work queued before the clear',
    offlineQueueService.getQueue().length === 2,
  );

  const cleared = await mobileApp.clearLocalData();
  check(
    'clearing local data clears the queue — the precondition, asserted separately',
    cleared.queuedItemsCleared === 2 && offlineQueueService.getQueue().length === 0,
    cleared,
  );
  check(
    'and the credential SURVIVES the clear',
    (await credentialStore.deviceToken()) === 'otd_live-token',
    await credentialStore.deviceToken(),
  );
  check('and the identity survives it too', (await credentialStore.deviceId()) === liveId, {
    liveId,
    now: await credentialStore.deviceId(),
  });

  // And in STORAGE, asked of a fresh instance — the cached answer above cannot
  // tell the difference between an identity that was kept and one that was
  // dropped after the cache had been filled.
  const restartedAfterClearLocal = restartOf(liveStore);
  const idAfterClearLocal = await restartedAfterClearLocal.deviceId();
  check(
    'and the identity survives it in STORAGE — the next launch is the same device',
    idAfterClearLocal === liveId,
    { liveId, idAfterClearLocal },
  );

  // -------------------------------------------------------------------------
  section('4. portalApi wiring — restore, refuse, forget');

  const wiredStore = new MemorySecureStore();
  credentialStore.useStorage(wiredStore);
  await credentialStore.saveDeviceToken('otd_wired-token');

  const restored = await restoreCredential();
  check(
    'restoreCredential reports the identity and the credential it found',
    restored.deviceId === (await credentialStore.deviceId()) && restored.hasToken === true,
    restored,
  );
  check(
    'deviceId() now answers with the persisted identity instead of throwing',
    deviceId() === restored.deviceId,
    { deviceId: deviceId(), restored: restored.deviceId },
  );
  check('hasDeviceToken() is true once restored', hasDeviceToken() === true);
  check('currentDeviceId() agrees', currentDeviceId() === restored.deviceId);

  await forgetCredential();
  check(
    'forgetCredential clears the credential from memory and from storage',
    hasDeviceToken() === false && (await credentialStore.deviceToken()) === null,
    { hasDeviceToken: hasDeviceToken(), stored: await credentialStore.deviceToken() },
  );
  check(
    'and leaves the identity in place, so re-enrolling is the same device',
    (await credentialStore.deviceId()) === restored.deviceId,
    { restored: restored.deviceId, now: await credentialStore.deviceId() },
  );

  const restartedAfterForget = restartOf(wiredStore);
  const idAfterForget = await restartedAfterForget.deviceId();
  check(
    'and the identity is still in STORAGE after forgetting the credential',
    idAfterForget === restored.deviceId,
    { restored: restored.deviceId, idAfterForget },
  );

  // -------------------------------------------------------------------------
  section('5. The harness overlay — ONETEAM_DEVICE_ID names this process');

  // The Node runner has no keychain, so it names itself with the environment
  // variable, and its write tier renames itself mid-run. That only works if the
  // variable is consulted BEFORE the restored identity — and the reason it is
  // safe to put it first is that it cannot exist in a shipping build at all:
  // Metro inlines only `EXPO_PUBLIC_*`, and only as a direct member expression,
  // while this module reads `process.env` through a local alias.
  //
  // The rule being checked is "overlay, not replacement": the installation's own
  // identity is still read underneath, so removing the variable falls back to
  // the device's real identity rather than leaving the process with nothing.
  const overlayStore = new MemorySecureStore();
  await overlayStore.set(DEVICE_ID_KEY, 'dev-the-installations-own-identity');
  credentialStore.useStorage(overlayStore);

  process.env.ONETEAM_DEVICE_ID = 'test-device-e2e';
  const overlaid = await restoreCredential();
  check(
    'an explicit ONETEAM_DEVICE_ID is the identity this process uses',
    overlaid.deviceId === 'test-device-e2e',
    overlaid,
  );
  check(
    'deviceId() agrees with it, and does not throw',
    deviceId() === 'test-device-e2e',
    deviceId(),
  );
  check(
    'the overlay is NOT written over the installation identity in storage',
    (await overlayStore.get(DEVICE_ID_KEY)) === 'dev-the-installations-own-identity',
    await overlayStore.get(DEVICE_ID_KEY),
  );

  delete process.env.ONETEAM_DEVICE_ID;
  check(
    'with the overlay removed, the device falls back to its OWN identity',
    deviceId() === 'dev-the-installations-own-identity' &&
      currentDeviceId() === 'dev-the-installations-own-identity',
    { deviceId: deviceId(), currentDeviceId: currentDeviceId() },
  );

  // -------------------------------------------------------------------------
  console.log(`\n${colors.cyan}${'─'.repeat(74)}${colors.reset}`);
  const total = passed + failed;
  const line = `${passed}/${total} checks passed`;
  console.log(
    failed === 0
      ? `  ${colors.green}${colors.bright}✅ ${line}${colors.reset}`
      : `  ${colors.red}${colors.bright}❌ ${line}${colors.reset}`,
  );
  console.log(
    `  ${colors.yellow}Not covered here:${colors.reset} the iOS keychain itself. ` +
      `keychain.ts calls a native\n  module and is not imported by this suite, so ` +
      `nothing here has run on a device.`,
  );
  console.log(`${colors.cyan}${'─'.repeat(74)}${colors.reset}\n`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`${colors.red}The suite itself failed:${colors.reset}`, error);
  process.exit(1);
});
