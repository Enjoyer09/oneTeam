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
    return await restoreCredential();
  }

  /**
   * Clears the device's local working data and keeps the credential.
   *
   * The queue is what is being cleared: a captured audit that has not been sent
   * yet, or that failed and is waiting to be retried. Dropping it is a decision
   * the worker makes ("start over"), and it is recoverable — the photo is still
   * in the camera roll if the phone kept it, and the audit was never filed.
   *
   * The credential is NOT part of it, and that split is the requirement: losing
   * the credential costs one sign-in, but losing the IDENTITY costs the device
   * its whole audit history and spends the store's new-device allowance. So this
   * method exists to be the one place that clears local state, and to say in code
   * that the keychain is not its business. A future "sign out" button belongs
   * here rather than rolling its own cleanup.
   *
   * Returns what it cleared, so a caller — or a test — can tell that it did
   * something. A cleanup that silently does nothing passes every "and the
   * credential survived" check for the wrong reason.
   */
  clearLocalData(): { queuedItemsCleared: number } {
    const queuedItemsCleared = offlineQueueService.getQueue().length;
    offlineQueueService.clearQueue();
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
