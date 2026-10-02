/**
 * The application shell.
 * ============================================================================
 *
 * WHAT THIS IS
 * ------------
 * This is the app's root component: the thing Expo boots, that holds the status
 * bar and the safe area, that starts the credential machinery, and that mounts
 * the field screens inside.
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
 * SCREEN NAVIGATION
 * -----------------
 * The app uses a simple `useState`-driven screen stack rather than a navigation
 * library. The reason is that `expo-router` and `react-navigation` both need
 * the full Expo dependency tree, which cannot be installed in this environment.
 * A stack of three values — `screen`, `store`, `task` — is enough for the five
 * screens the plan names, and it keeps the shell free of dependencies that would
 * make `mobile:check` fail.
 *
 *   Login → TaskList → TaskDetail → Camera → (back to TaskList)
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

import { useEffect, useState, useCallback } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, StyleSheet, AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { mobileApp } from './src/App';
import { credentialStore } from './src/services/credentialStore';
import { keychainAvailable, keychainStore } from './src/services/keychain';
import { offlineQueueService } from './src/services/offlineQueue';
import { asyncStorageQueue, queueStorageAvailable } from './src/services/queueStorage';
import {
  networkAvailable,
  getCurrentOnlineStatus,
  subscribeToConnectivity,
} from './src/services/network';

import type { MobileStore, MobileTask, GPSCoordinates } from './src/types';
import type { ChecklistAnswer } from './src/screens/TaskDetailScreen';

import { LoginScreenUI } from './src/screens/LoginScreenUI';
import { TaskListScreenUI } from './src/screens/TaskListScreenUI';
import { TaskDetailScreen } from './src/screens/TaskDetailScreen';
import { CameraAuditScreenUI } from './src/screens/CameraAuditScreenUI';

/**
 * The authenticated screens carry `userGPS` — the fix the sign-in geofence was
 * evaluated against.
 *
 * It is part of every authenticated variant rather than a value `handleOpenCamera`
 * looks up, so that a future screen cannot silently drop it: TypeScript refuses
 * to compile a transition that loses it. That matters because the defect being
 * fixed here was exactly a dropped value — `handleOpenCamera` filled the gap
 * with a hardcoded `{40.4093, 49.8671}` and stamped it into every audit.
 *
 * It is NOT optional, and there is no default. A missing fix must be a
 * compile error, not a plausible-looking constant.
 */
type Screen =
  | { name: 'loading' }
  | { name: 'login' }
  | { name: 'taskList'; store: MobileStore; userGPS: GPSCoordinates }
  | { name: 'taskDetail'; store: MobileStore; task: MobileTask; userGPS: GPSCoordinates }
  | {
      name: 'camera';
      store: MobileStore;
      task: MobileTask;
      userGPS: GPSCoordinates;
      checklistAnswers: ChecklistAnswer[];
    };

export function Root() {
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });
  const [failure, setFailure] = useState<string | null>(null);

  // Startup sequence: credentials, then queue. Must complete before any screen
  // that calls the API is shown.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const persistent = await keychainAvailable();
        if (persistent) credentialStore.useStorage(keychainStore);

        await mobileApp.initializeCredentials();

        const queueIsPersistent = await queueStorageAvailable();
        if (queueIsPersistent) offlineQueueService.useStorage(asyncStorageQueue);
        await mobileApp.initializeQueue();

        // Seed the queue with a real connectivity reading before the first drain.
        // The queue defaults to "online", so without this a worker who opens the
        // app already in a dead zone would have their first capture attempt an
        // upload instead of being queued. `networkAvailable` gates it: if the
        // platform cannot report connectivity we leave the default and lean on the
        // startup/foreground/manual drains, exactly as this file did before.
        const hasNetworkSignal = await networkAvailable();
        if (hasNetworkSignal) {
          offlineQueueService.setOnlineStatus(await getCurrentOnlineStatus());
        }

        // A drain attempt at startup, for audits a previous session queued and
        // never sent. The reconnection edge is now wired too (see the connectivity
        // effect below), but startup has no offline→online transition to hang a
        // drain on, so this stays. Fire-and-forget: it must not block reaching the
        // login screen, and it never throws.
        void mobileApp.drainQueueOnResume();

        if (!cancelled) {
          setScreen({ name: 'login' });
        }
      } catch (error) {
        if (!cancelled) {
          setFailure(error instanceof Error ? error.message : String(error));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Drain when the radio comes back — the case this app could not see before.
  //
  // `expo-network` now watches connectivity, and its offline→online edge drives
  // `setOnlineStatus`, whose edge fires the reconnection drain inside the queue.
  // So "the worker walked out of the basement and the signal came back while the
  // app was open" is finally an event the app observes directly, rather than one
  // that waited for the next foreground. Gated on `networkAvailable`: if the
  // platform gives no signal, no listener is wired and the foreground/startup/
  // manual drains carry the load as they did. `setOnlineStatus` never throws.
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      if (!(await networkAvailable())) return;
      if (cancelled) return;
      unsubscribe = subscribeToConnectivity((online) => {
        offlineQueueService.setOnlineStatus(online);
      });
    })();

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, []);

  // Drain when the app returns to the foreground.
  //
  // Kept as a safety net alongside the connectivity listener above: the listener
  // catches the reconnection edge, but foregrounding also covers the app being
  // reopened after a background kill, when there is no edge to observe. Together
  // with the startup drain and the manual button, queued audits are not
  // stranded. `drainQueueOnResume` respects the retry cap and never throws.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void mobileApp.drainQueueOnResume();
      }
    });
    return () => {
      subscription.remove();
    };
  }, []);

  const handleLoginSuccess = useCallback(
    (result: {
      store: MobileStore;
      tasks: unknown[];
      claimedTaskCount: number;
      userGPS: GPSCoordinates;
    }) => {
      setScreen({ name: 'taskList', store: result.store, userGPS: result.userGPS });
    },
    [],
  );

  const handleSelectTask = useCallback((task: MobileTask) => {
    setScreen((prev) => {
      if (prev.name === 'taskList') {
        return { name: 'taskDetail', store: prev.store, task, userGPS: prev.userGPS };
      }
      return prev;
    });
  }, []);

  const handleOpenCamera = useCallback(
    (params: {
      task: MobileTask;
      store: MobileStore;
      checklistAnswers: ChecklistAnswer[];
      userGPS: GPSCoordinates;
    }) => {
      // THE POSITION IS THE ONE THE GEOFENCE PASSED, AND IT IS PASSED IN.
      //
      // This used to read:
      //
      //     // GPS is carried from the login screen's fix. ... here we reuse the
      //     // one that passed the geofence, which is the honest position the
      //     // worker was verified at.
      //     const userGPS: GPSCoordinates = {
      //       latitude: 40.4093, longitude: 49.8671, accuracy: 10,
      //     };
      //
      // The comment described the intent and the code did the opposite: those
      // are the coordinates the OLD FAKE login returned, so every audit photo
      // was stamped with a constant regardless of where the worker stood. The
      // real fix was available one component away and never reached here.
      //
      // Now it arrives as an argument, it is required by the type, and there is
      // no fallback. If it is missing, the app does not compile.
      setScreen({
        name: 'camera',
        store: params.store,
        task: params.task,
        userGPS: params.userGPS,
        checklistAnswers: params.checklistAnswers,
      });
    },
    [],
  );

  const handleBackToTaskList = useCallback(() => {
    setScreen((prev) => {
      if (prev.name === 'taskDetail' || prev.name === 'camera') {
        return { name: 'taskList', store: prev.store, userGPS: prev.userGPS };
      }
      return prev;
    });
  }, []);

  const handleBackToTaskDetail = useCallback(() => {
    setScreen((prev) => {
      if (prev.name === 'camera') {
        return {
          name: 'taskDetail',
          store: prev.store,
          task: prev.task,
          userGPS: prev.userGPS,
        };
      }
      return prev;
    });
  }, []);

  const handleLogout = useCallback(() => {
    setScreen({ name: 'login' });
  }, []);

  // Render the current screen
  const renderScreen = () => {
    if (failure) {
      // A fatal startup failure is reported with the same plain style the old
      // shell used, so the error is visible rather than swallowed.
      return (
        <View style={styles.fatalContainer}>
          <StatusBar style="dark" />
          <View style={styles.fatalCard}>
            <View style={styles.fatalDot} />
            <View>
              <Text style={styles.fatalTitle}>Başlanğıc alınmadı</Text>
              <Text style={styles.fatalMessage}>{failure}</Text>
            </View>
          </View>
        </View>
      );
    }

    switch (screen.name) {
      case 'loading':
        return (
          <View style={styles.loadingContainer}>
            <StatusBar style="dark" />
            <ActivityIndicator size="large" color="#0066CC" />
            <Text style={styles.loadingText}>Başlanğıc yoxlanılır…</Text>
          </View>
        );

      case 'login':
        return (
          <>
            <StatusBar style="dark" />
            <LoginScreenUI onLoginSuccess={handleLoginSuccess} />
          </>
        );

      case 'taskList':
        return (
          <>
            <StatusBar style="dark" />
            <TaskListScreenUI
              store={screen.store}
              onSelectTask={handleSelectTask}
              onLogout={handleLogout}
            />
          </>
        );

      case 'taskDetail':
        return (
          <>
            <StatusBar style="dark" />
            <TaskDetailScreen
              task={screen.task}
              store={screen.store}
              userGPS={screen.userGPS}
              onBack={handleBackToTaskList}
              onOpenCamera={handleOpenCamera}
            />
          </>
        );

      case 'camera':
        return (
          <>
            <StatusBar style="light" />
            <CameraAuditScreenUI
              task={screen.task}
              store={screen.store}
              userGPS={screen.userGPS}
              checklistAnswers={screen.checklistAnswers}
              onComplete={handleBackToTaskList}
              onCancel={handleBackToTaskDetail}
            />
          </>
        );

      default:
        return null;
    }
  };

  return (
    <SafeAreaProvider>
      <View style={styles.screen}>{renderScreen()}</View>
    </SafeAreaProvider>
  );
}

// Minimal imports for the fatal error screen — these are only used when the
// app cannot start at all, so they are kept inline rather than adding a
// dependency on the full screen set.
function Text(props: { style?: any; children: React.ReactNode }) {
  // `require` here is deliberate, not an oversight: these two components exist
  // only for the fatal-error screen, and importing `react-native` at the top of
  // this file would make startup depend on it before we know it can load.
  // eslint-disable-next-line no-undef, @typescript-eslint/no-require-imports
  const RN = require('react-native');
  return <RN.Text style={props.style}>{props.children}</RN.Text>;
}

function ActivityIndicator(props: { size?: string | number; color?: string }) {
  // `require` here is deliberate, not an oversight: these two components exist
  // only for the fatal-error screen, and importing `react-native` at the top of
  // this file would make startup depend on it before we know it can load.
  // eslint-disable-next-line no-undef, @typescript-eslint/no-require-imports
  const RN = require('react-native');
  return <RN.ActivityIndicator size={props.size} color={props.color} />;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 15,
    color: '#666666',
  },
  fatalContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    padding: 24,
  },
  fatalCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#FFF5F5',
    borderRadius: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: '#FFD6D6',
    width: '100%',
  },
  fatalDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#B00020',
    marginTop: 6,
    marginRight: 12,
  },
  fatalTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#B00020',
  },
  fatalMessage: {
    marginTop: 6,
    fontSize: 14,
    color: '#666666',
    lineHeight: 20,
  },
});
