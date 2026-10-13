export interface DraftStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
export class ChecklistDrafts {
  private drafts: Record<string, Record<string, string>> = {};
  private storage?: DraftStorage;
  private writes: Promise<void> = Promise.resolve();
  private key(storeId: string, taskId: string) {
    return JSON.stringify([storeId, taskId]);
  }
  async initialize(storage: DraftStorage) {
    this.storage = storage;
    const raw = await storage.getItem('oneteam.checklistDrafts.v1');
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Qaralamalar oxuna bilmədi.');
    for (const value of Object.values(parsed)) {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.values(value).some((v) => typeof v !== 'string')
      )
        throw new Error('Qaralamalar oxuna bilmədi.');
    }
    this.drafts = parsed as Record<string, Record<string, string>>;
  }
  get(storeId: string, taskId: string) {
    return { ...this.drafts[this.key(storeId, taskId)] };
  }
  save(storeId: string, taskId: string, answers: Record<string, string>) {
    this.drafts[this.key(storeId, taskId)] = { ...answers };
    return this.persist();
  }
  clear(storeId: string, taskId: string) {
    delete this.drafts[this.key(storeId, taskId)];
    return this.persist();
  }
  private persist() {
    const snapshot = JSON.stringify(this.drafts);
    const write = this.writes
      .catch(() => {})
      .then(() => this.storage?.setItem('oneteam.checklistDrafts.v1', snapshot));
    this.writes = write;
    return write;
  }
}
export const checklistDrafts = new ChecklistDrafts();
