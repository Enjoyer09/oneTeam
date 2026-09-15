/**
 * The application shell.
 * ============================================================================
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * This is the app's root component: the thing Expo boots, that holds the status
 * bar and the safe area, that starts the credential machinery, and that later
 * screens will be mounted inside.
 *
 * It is NOT the field UI. The Login, TaskList, TaskDetail, Checklist and Camera
 * screens named in the Phase 3 plan do not exist yet — `mobile/src/screens/*`
 * holds `*Controller` classes with no React in them at all, and there is no JSX,
 * no `react-native` import and no `StyleSheet` anywhere under `mobile/src`. So
 * there is nothing to "preserve unchanged" (plan item 3.5) and nothing to mount
 * yet; those screens have to be written.
 *
 * Rather than ship a screen that looks like a working login and is not one, this
 * shell reports the app's actual state: where it will send its requests, which
 * installation it is, whether it holds a credential, and whether that credential
 * will survive the app being closed. Every value is read from the same modules
 * the real screens will use, so what is on screen cannot drift from what the app
 * would do.
 *
 * WHY THE STARTUP ORDER IS WHAT IT IS
 * -----------------------------------
 * Four steps, and the order matters:
 *
 *   1. Point the credential store at the keychain, if this device has one.
 *      Skipping this leaves the store on its in-memory default, and the app then
 *      re-enrols on every launch — which is not a crash, it is worse: it looks
 *      like it works, and each launch spends the store's new-device allowance.
 *   2. Read the identity and the credential back. This is what makes enrolment
 *      automatic on every launch after the first.
 *   3. Point the offline queue at AsyncStorage, if this device has it. Skipping
 *      this leaves the queue in memory, so a captured audit survives until the
 *      app is closed and no longer.
 *   4. Read the queued audits back. Until this has run the queue refuses to be
 *      read rather than answering with an empty list, because "nothing is
 *      queued" and "nobody has looked" are the same thing to a caller that only
 *      sees an empty array.
 *
 * Only then let anything call the API. `portalApi.deviceId()` throws until step
 * 2 has run, on purpose: the value it used to fall back to was shared by every
 * unconfigured installation, and the API allows one live credential per device
 * id, so those installations used to sign each other out. See
 * `src/services/credentialStore.ts`.
 *
 * This file is the ONLY place allowed to import `src/services/keychain.ts` or
 * `src/services/queueStorage.ts`. The policy under `src/services/` must stay
 * free of native imports so it can run under Node; that is the whole reason both
 * storages are interfaces.
 *
 * It is deliberately plain. No brand colour is invented here — a guessed hex
 * would be a claim about the brand that nobody checked.
 *
 * WHY THIS FILE SITS AT THE PACKAGE ROOT AND NOT UNDER `src/`
 * -----------------------------------------------------------
 * `mobile/tsconfig.json` includes only the `src` tree, and that include is what
 * `npm run mobile:check` type-checks in CI. This file imports `react-native`,
 * which is not installed — the Expo dependency tree could not be installed in
 * the environment where it was written (see the Phase 3.1 notes in
 * `docs/PRODUCT-PLAN-AZ.md`). Putting it under `src/` would therefore have
 * turned a green check red for a reason that has nothing to do with the code.
 *
 * The cost is real and is recorded rather than hidden: **this file is not
 * type-checked.** Once `npm install` has been run in `mobile/`, add `index.ts`
 * and `Root.tsx` to `include` in `mobile/tsconfig.json` so that it is.
 */

import { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { mobileApp } from './src/App';
import { credentialStore } from './src/services/credentialStore';
import { keychainAvailable, keychainStore } from './src/services/keychain';
import { offlineQueueService } from './src/services/offlineQueue';
import { asyncStorageQueue, queueStorageAvailable } from './src/services/queueStorage';

/** What the startup sequence learned, or null while it is still running. */
type Startup = {
  deviceId: string;
  hasCredential: boolean;
  storage: 'keychain' | 'memory';
  queueStorage: 'device' | 'memory';
  pendingCount: number;
  interruptedCount: number;
  droppedCount: number;
  corrupted: boolean;
};

/** One line of the status readout. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

export function Root() {
  const [startup, setStartup] = useState<Startup | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const persistent = await keychainAvailable();
      if (persistent) credentialStore.useStorage(keychainStore);

      const restored = await mobileApp.initializeCredentials();

      // Step 3 and 4. Wired before anything can enqueue: `enqueueSubmission`
      // awaits the load itself, so an audit captured before this ran cannot
      // overwrite what is on disk.
      const queueIsPersistent = await queueStorageAvailable();
      if (queueIsPersistent) offlineQueueService.useStorage(asyncStorageQueue);
      const queue = await mobileApp.initializeQueue();

      if (!cancelled) {
        setStartup({
          deviceId: restored.deviceId,
          hasCredential: restored.hasToken,
          storage: persistent ? 'keychain' : 'memory',
          queueStorage: queueIsPersistent ? 'device' : 'memory',
          pendingCount: queue.pendingCount,
          interruptedCount: queue.interruptedCount,
          droppedCount: queue.droppedCount,
          corrupted: queue.corruption !== null,
        });
      }
    })().catch((error) => {
      // Reported on screen rather than swallowed. A startup that fails silently
      // and leaves the app looking ready is how a device ends up enrolling as
      // somebody else.
      if (!cancelled) setFailure(error instanceof Error ? error.message : String(error));
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>oneTeam Field Audit</Text>
        <Text style={styles.subtitle}>Coca-Cola rəf monitorinqi — sahə tətbiqi</Text>

        {failure ? (
          <Text style={styles.failure}>Başlanğıc alınmadı: {failure}</Text>
        ) : !startup ? (
          <Text style={styles.note}>Başlanğıc yoxlanılır…</Text>
        ) : (
          <>
            <View style={styles.card}>
              <Row label="API ünvanı" value={mobileApp.describeApiTarget()} />
              <Row label="Cihaz identifikatoru" value={startup.deviceId} />
              <Row label="Cihaz qeydiyyatı" value={startup.hasCredential ? 'var' : 'yoxdur'} />
              <Row
                label="Açarın saxlandığı yer"
                value={
                  startup.storage === 'keychain'
                    ? 'Açar saxlayıcı (keychain)'
                    : 'Yalnız yaddaş — hər açılışda yenidən qeydiyyat'
                }
              />
              <Row
                label="Gözləyən audit"
                value={
                  startup.pendingCount === 0
                    ? 'yoxdur'
                    : `${startup.pendingCount} ədəd göndərilməyi gözləyir`
                }
              />
              <Row
                label="Növbənin saxlandığı yer"
                value={
                  startup.queueStorage === 'device'
                    ? 'Cihazın yaddaşı — tətbiq bağlansa da qalır'
                    : 'Yalnız yaddaş — tətbiq bağlananda itir'
                }
              />
            </View>

            <Text style={styles.note}>
              Bu, tətbiqin karkasıdır. Sahə ekranları — giriş, tapşırıq siyahısı, çeklist və kamera
              — hələ yazılmayıb.
            </Text>

            {startup.storage === 'memory' ? (
              <Text style={styles.warning}>
                Bu cihazda açar saxlayıcı əlçatan deyil, ona görə identifikator yalnız yaddaşdadır
                və tətbiq hər açılışda yenidən qeydiyyatdan keçəcək. Bu, tətbiqi sındırmır, amma
                mağazanın yeni cihaz limitini boş yerə xərcləyir.
              </Text>
            ) : null}

            {startup.queueStorage === 'memory' ? (
              <Text style={styles.warning}>
                Bu cihazda növbə üçün yaddaş əlçatan deyil. Çəkilmiş, amma göndərilməmiş auditlər
                tətbiq bağlananda İTİRİLƏCƏK. Bu halda foto çəkməzdən əvvəl şəbəkənin olduğuna əmin
                olun.
              </Text>
            ) : null}

            {startup.interruptedCount > 0 ? (
              <Text style={styles.warning}>
                {startup.interruptedCount} audit göndərilmə əsnasında yarımçıq qalıb. Onlar artıq
                qeydə alınmış ola bilər, ona görə avtomatik təkrar cəhd dayandırıldı — yoxlamadan
                təkrar göndərməyin.
              </Text>
            ) : null}

            {startup.corrupted ? (
              <Text style={styles.failure}>
                Növbə faylı oxuna bilmədi. İçindəki auditlər bərpa oluna bilməz. Bu, adətən yaddaşın
                zədələnməsi deməkdir.
              </Text>
            ) : null}

            {startup.droppedCount > 0 ? (
              <Text style={styles.warning}>
                {startup.droppedCount} qeyd zədəli olduğu üçün növbədən çıxarıldı.
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  content: {
    padding: 24,
    paddingTop: 72,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111111',
  },
  subtitle: {
    marginTop: 4,
    fontSize: 14,
    color: '#666666',
  },
  card: {
    marginTop: 24,
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  row: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E0E0E0',
  },
  rowLabel: {
    fontSize: 12,
    color: '#888888',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rowValue: {
    marginTop: 2,
    fontSize: 15,
    color: '#111111',
  },
  note: {
    marginTop: 24,
    fontSize: 14,
    lineHeight: 21,
    color: '#444444',
  },
  warning: {
    marginTop: 16,
    fontSize: 14,
    lineHeight: 21,
    color: '#8A5A00',
  },
  failure: {
    marginTop: 24,
    fontSize: 14,
    lineHeight: 21,
    color: '#B00020',
  },
});
