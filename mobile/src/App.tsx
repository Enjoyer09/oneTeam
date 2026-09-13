import { LoginScreenController } from './screens/LoginScreen';
import { TaskListController } from './screens/TaskListScreen';
import { CameraAuditController } from './screens/CameraAuditScreen';
import { AuditHistoryController } from './screens/AuditHistoryScreen';
import { offlineQueueService } from './services/offlineQueue';
import { MobileStore, MobileTask, GPSCoordinates } from './types';

export class MobileAppCoordinator {
  public login = new LoginScreenController();
  public taskList = new TaskListController();
  public history = new AuditHistoryController();
  public currentStore: MobileStore | null = null;
  public selectedTask: MobileTask | null = null;

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
}

export const mobileApp = new MobileAppCoordinator();
