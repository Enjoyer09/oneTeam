import { LoginScreenController } from './screens/LoginScreen';
import { TaskListController } from './screens/TaskListScreen';
import { CameraAuditController } from './screens/CameraAuditScreen';
import { AuditHistoryController } from './screens/AuditHistoryScreen';
import { offlineQueueService } from './services/offlineQueue';
import { mobileApi, restoreCredential } from './services/portalApi';
import { MobileStore, MobileTask, GPSCoordinates } from './types';

export class MobileAppCoordinator {
  public login = new LoginScreenController();
  public taskList = new TaskListController();
  public history = new AuditHistoryController();
  public currentStore: MobileStore | null = null;
  public selectedTask: MobileTask | null = null;

  /**
   * Reads this installation's identity and credential, minting the identity on
   * the first launch.
   *
   * MUST run before anything calls the API. It is the only step that can produce
   * the identity, and `portalApi.deviceId()` throws rather than inventing one —
   * the default it used to invent was shared by every unconfigured installation,
   * which made them revoke each other's credentials. See `credentialStore.ts`.
   */
  async initializeCredentials() {
    return restoreCredential();
  }

  /**
   * Reads the queued audits back off the device.
   *
   * MUST run before anything reads the queue. The queue's storage is wired by
   * the app entry (it is the file that may import a native module), and until
   * this has run the in-memory queue is not the whole queue — so
   * `getQueue()` refuses rather than answering with an empty array that would
   * look identical to "nothing is queued". See `OfflineQueueManager.assertLoaded`.
   *
   * Returns what it found, including anything the last launch left in flight, so
   * the caller can say so instead of the count quietly being wrong.
   */
  async initializeQueue() {
    const report = await offlineQueueService.load();
    return {
      pendingCount: offlineQueueService.getPendingCount(),
      restoredCount: report.restoredCount,
      interruptedCount: report.interruptedCount,
      droppedCount: report.droppedCount,
      corruption: report.corruption,
    };
  }

  /**
   * Clears the device's local working data and keeps the credential.
   *
   * The queue is what is being cleared: a captured audit that has not been sent
   * yet, or that failed and is waiting to be retried. Dropping it is a decision
   * the worker makes ("start over"), and it is recoverable — the photo is still
   * in the camera roll if the phone kept it, and the audit was never filed.
   *
   * Async because it has to be. Plan item 3.3 put the queue on the device, so a
   * clear that only emptied the in-memory array would bring every item back on
   * the next launch — the opposite of starting over. The count comes back from
   * `clearQueue()`, which is the same call that did the clearing, so a test
   * cannot be told "two were removed" by something that removed none.
   *
   * The credential is NOT part of it, and that split is the requirement: losing
   * the credential costs one sign-in, but losing the IDENTITY costs the device
   * its whole audit history and spends the store's new-device allowance. So this
   * method exists to be the one place that clears local state, and to say in code
   * that the keychain is not its business. A future "sign out" button belongs
   * here rather than rolling its own cleanup.
   */
  async clearLocalData(): Promise<{ queuedItemsCleared: number }> {
    const queuedItemsCleared = await offlineQueueService.clearQueue();
    return { queuedItemsCleared };
  }

  /**
   * Signs in at a store and loads its work.
   *
   * `userGPS` is required rather than defaulted. The login controller refuses to
   * run without a real fix, because the geofence compares the device's position
   * against the store's and a made-up position makes that comparison meaningless
   * while still looking authoritative.
   */
  async initializeSession(storeCode: string, userGPS: GPSCoordinates) {
    this.login.setStoreCode(storeCode);
    this.login.setUserLocation(userGPS);

    const authResult = await this.login.authenticateAndVerifyStore();
    if (!authResult.success || !authResult.store) {
      throw new Error(authResult.error || 'Authentication / Geofence failed');
    }

    this.currentStore = authResult.store;
    await this.taskList.loadTasks(this.currentStore.id);

    return {
      store: this.currentStore,
      geofence: authResult.geofence,
      tasks: this.taskList.getTasks(),
      // How much of the store's open work this device just claimed. Saying it is
      // the difference between "I signed in" and "there is work waiting for me".
      claimedTaskCount: authResult.claimedTaskCount ?? 0,
    };
  }

  createCameraSession(task: MobileTask) {
    if (!this.currentStore) throw new Error('No active store logged in');
    this.selectedTask = task;
    return new CameraAuditController(task, this.currentStore);
  }

  getOfflineQueueService() {
    return offlineQueueService;
  }

  /** Where this client is pointing, for startup logs. */
  describeApiTarget(): string {
    return mobileApi.describeTarget();
  }
}

export const mobileApp = new MobileAppCoordinator();
