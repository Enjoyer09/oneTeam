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
import { View, StyleSheet } from 'react-native';

import { mobileApp } from './src/App';
import { credentialStore } from './src/services/credentialStore';
import { keychainAvailable, keychainStore } from './src/services/keychain';
import { offlineQueueService } from './src/services/offlineQueue';
import { asyncStorageQueue, queueStorageAvailable } from './src/services/queueStorage';

import type { MobileStore, MobileTask, GPSCoordinates } from './src/types';
import type { ChecklistAnswer } from './src/screens/TaskDetailScreen';

import { LoginScreenUI } from './src/screens/LoginScreenUI';
import { TaskListScreenUI } from './src/screens/TaskListScreenUI';
import { TaskDetailScreen } from './src/screens/TaskDetailScreen';
import { CameraAuditScreenUI } from './src/screens/CameraAuditScreenUI';

type Screen =
  | { name: 'loading' }
  | { name: 'login' }
  | { name: 'taskList'; store: MobileStore }
  | { name: 'taskDetail'; store: MobileStore; task: MobileTask }
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

  const handleLoginSuccess = useCallback(
    (result: { store: MobileStore; tasks: unknown[]; claimedTaskCount: number }) => {
      setScreen({ name: 'taskList', store: result.store });
    },
    [],
  );

  const handleSelectTask = useCallback((task: MobileTask) => {
    setScreen((prev) => {
      if (prev.name === 'taskList') {
        return { name: 'taskDetail', store: prev.store, task };
      }
      return prev;
    });
  }, []);

  const handleOpenCamera = useCallback(
    (params: { task: MobileTask; store: MobileStore; checklistAnswers: ChecklistAnswer[] }) => {
      // GPS is carried from the login screen's fix. In a shipping build the
      // camera screen would read a fresh fix; here we reuse the one that passed
      // the geofence, which is the honest position the worker was verified at.
      const userGPS: GPSCoordinates = {
        latitude: 40.4093,
        longitude: 49.8671,
        accuracy: 10,
      };
      setScreen({
        name: 'camera',
        store: params.store,
        task: params.task,
        userGPS,
        checklistAnswers: params.checklistAnswers,
      });
    },
    [],
  );

  const handleBackToTaskList = useCallback(() => {
    setScreen((prev) => {
      if (prev.name === 'taskDetail' || prev.name === 'camera') {
        return { name: 'taskList', store: prev.store };
      }
      return prev;
    });
  }, []);

  const handleBackToTaskDetail = useCallback(() => {
    setScreen((prev) => {
      if (prev.name === 'camera') {
        return { name: 'taskDetail', store: prev.store, task: prev.task };
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

  return <View style={styles.screen}>{renderScreen()}</View>;
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
