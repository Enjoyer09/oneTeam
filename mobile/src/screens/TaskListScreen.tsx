import { MobileTask, MobileStore } from '../types';
import { mobileSupabase } from '../services/supabaseMobile';

export class TaskListController {
  private tasks: MobileTask[] = [];

  async loadTasks(storeId: string): Promise<MobileTask[]> {
    this.tasks = await mobileSupabase.getTasksForStore(storeId);
    return [...this.tasks];
  }

  getTasks(): MobileTask[] {
    return [...this.tasks];
  }
}

export class TaskDetailController {
  private task: MobileTask;
  private store: MobileStore;

  constructor(task: MobileTask, store: MobileStore) {
    this.task = task;
    this.store = store;
  }

  getPlanogramDetails() {
    return {
      title: this.task.title,
      instructions: this.task.description,
      coolingRequirement: this.task.cooling_requirement || '≤ 4°C',
      facingsPerSku: this.task.facings_per_sku || 3,
      referenceImageUrl: this.task.reference_image_url,
      priority: this.task.priority,
      deadline: this.task.deadline,
      storeName: this.store.name,
      storeCode: this.store.store_code,
    };
  }
}
