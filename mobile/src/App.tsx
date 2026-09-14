import { LoginScreenController } from './screens/LoginScreen';
import { TaskListController } from './screens/TaskListScreen';
import { CameraAuditController } from './screens/CameraAuditScreen';
import { AuditHistoryController } from './screens/AuditHistoryScreen';
import { offlineQueueService } from './services/offlineQueue';
import { mobileApi } from './services/portalApi';
import { MobileStore, MobileTask, GPSCoordinates } from './types';

export class MobileAppCoordinator {
  public login = new LoginScreenController();
  public taskList = new TaskListController();
  public history = new AuditHistoryController();
  public currentStore: MobileStore | null = null;
  public selectedTask: MobileTask | null = null;

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
