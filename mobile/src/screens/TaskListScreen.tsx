import { MobileTask, MobileStore } from '../types';
import { mobileApi } from '../services/portalApi';

export class TaskListController {
  private tasks: MobileTask[] = [];

  async loadTasks(storeId: string): Promise<MobileTask[]> {
    this.tasks = await mobileApi.getTasksForStore(storeId);
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

  /**
   * What the field worker is shown before taking the photo.
   *
   * `coolingRequirement` and `facingsPerSku` used to be here, defaulting to
   * `'≤ 4°C'` and `3` whenever the task did not carry them — which was always,
   * because the rules never left the server. A merchandiser reading an invented
   * planogram is worse served than one reading none, so the real rules are
   * returned now, and an empty list means the template genuinely has none.
   */
  getPlanogramDetails() {
    return {
      title: this.task.title,
      instructions: this.task.description,
      referenceImageUrl: this.task.reference_image_url,
      priority: this.task.priority,
      deadline: this.task.deadline,
      storeName: this.store.name,
      storeCode: this.store.store_code,
      planogramRules: this.task.planogram_rules ?? [],
      checklistQuestions: this.task.checklist_schema ?? [],
    };
  }
}
