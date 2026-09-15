/**
 * oneTeam Supervisor Portal — API data layer
 * ============================================================================
 *
 * This file used to be called supabase.ts and talked to Supabase. It no longer
 * touches Supabase at all, which is why it was renamed: a module named after a
 * service it does not use is a trap for whoever reads it next.
 *
 * WHAT WAS WRONG BEFORE
 * ---------------------
 * The client fell back to `https://mock-oneteam.supabase.co` whenever
 * `VITE_SUPABASE_URL` was unset — which it always was. So the portal rendered a
 * hardcoded list of two stores and one task while the real database held three
 * stores and four tasks, and the two never met. Nothing in the UI said the data
 * was fake.
 *
 * HOW IT WORKS NOW
 * ----------------
 * Every call goes to `/api/portal/...` on the SAME ORIGIN, and nginx proxies it
 * to the API. Two consequences worth stating:
 *
 *   - No build-time credential. The base is a relative path, so the bundle
 *     works unchanged on localhost, in Docker Compose and on Railway. Vite
 *     inlines VITE_* variables at build time, so anything that had to be
 *     configured that way would need an image rebuild to change — which is
 *     exactly the kind of deploy surprise this rewrite is meant to remove.
 *
 *   - The credential is the signed-in person's own. It is attached here from
 *     `panelAuth`, which reads it from `localStorage`; see that module for why a
 *     key per person replaced the single admin token the edge used to inject.
 *     Before any key exists the edge still supplies one, and the panel is open —
 *     `panelAuth.fetchAuthStatus()` is what tells the shell which of the two
 *     situations it is in.
 *
 * The service keeps the exact method signatures the components already call, so
 * no component had to change.
 */

import { Store, Task, Submission, DashboardMetrics, SubmissionStatus } from '../types';
import { panelAuthHeaders } from './panelAuth';

const env: Record<string, any> =
  (typeof import.meta !== 'undefined' && (import.meta as any).env) ||
  (typeof process !== 'undefined' && process.env) ||
  {};

/**
 * Empty by default so requests are same-origin and go through the nginx proxy.
 * Set VITE_API_BASE_URL only to point the panel at an API on another host, which
 * would then need CORS and its own credential.
 */
const API_BASE = env.VITE_API_BASE_URL || '';

/**
 * A credential for direct API access, used only by the standalone smoke test.
 *
 * WHY THIS CANNOT LEAK INTO THE BROWSER
 * -------------------------------------
 * `env` is `import.meta.env` in a Vite build, and Vite only ever populates that
 * with `VITE_`-prefixed variables. `ONETEAM_API_TOKEN` has no such prefix, so a
 * production bundle can never contain it — and there is no code path that reads
 * it from a browser in the first place. In the deployed panel the bearer is
 * attached by nginx at the edge (see nginx.conf), which is why it can be rotated
 * without rebuilding the frontend.
 *
 * It exists because `npm run web:test` runs this module under Node against the
 * API directly, with no proxy in front of it to attach anything.
 */
const DIRECT_TOKEN = env.ONETEAM_API_TOKEN || '';

/** A hard failure the UI can show, rather than an empty dashboard. */
export class PortalApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'PortalApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(DIRECT_TOKEN ? { Authorization: `Bearer ${DIRECT_TOKEN}` } : {}),
        // A signed-in panel key comes after DIRECT_TOKEN, so it wins. In the
        // deployed panel DIRECT_TOKEN is empty and this is the only credential;
        // under `npm run web:test` there is no key and the environment token is
        // used, which is the one place a service credential is still correct.
        ...panelAuthHeaders(),
        ...(init?.headers ?? {}),
      },
    });
  } catch (cause) {
    // A network-level failure (DNS, offline, CORS preflight). Distinguished
    // from an HTTP error because the remedies are completely different.
    throw new PortalApiError(
      `API-yə qoşulmaq mümkün olmadı (${url}). Şəbəkəni yoxlayın.`,
      undefined,
    );
  }

  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new PortalApiError(
      `API gözlənilməz cavab qaytardı (HTTP ${response.status})`,
      response.status,
    );
  }

  if (!response.ok) {
    const detail =
      payload?.message ?? payload?.error ?? payload?.data?.message ?? response.statusText;
    throw new PortalApiError(
      Array.isArray(detail) ? detail.join('; ') : String(detail),
      response.status,
    );
  }

  return payload as T;
}

interface Envelope<T> {
  success: boolean;
  data: T;
  total?: number;
}

class PortalDataService {
  /**
   * Set when the API is unreachable, so the shell can tell "no data yet" apart
   * from "the API is down". Cleared on the next successful call.
   */
  public lastError: string | null = null;

  private async get<T>(path: string): Promise<T> {
    try {
      const body = await request<Envelope<T>>(path);
      this.lastError = null;
      return body.data;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async getMetrics(): Promise<DashboardMetrics> {
    return this.get<DashboardMetrics>('/api/portal/metrics');
  }

  async getStores(): Promise<Store[]> {
    return this.get<Store[]>('/api/portal/stores');
  }

  /**
   * The fields a supervisor fills in for a store.
   *
   * Snake case, matching the API and the `Store` shape the panel already
   * renders. Keeping one spelling across the wire and the UI avoids a
   * translation layer whose only job would be to be got wrong.
   */
  async createStore(data: {
    store_code: string;
    name: string;
    address: string;
    latitude: number;
    longitude: number;
    city?: string;
    chain_name?: string;
    store_format?: string;
    is_active?: boolean;
  }): Promise<Store> {
    const body = await request<Envelope<Store>>('/api/portal/stores', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return body.data;
  }

  /**
   * Applies a partial edit.
   *
   * Only the keys present are sent, and the API only touches what it receives —
   * so deactivating a store and correcting its address are the same call with a
   * different body, and neither can blank a field the form did not show.
   */
  async updateStore(id: string, changes: Partial<Store>): Promise<Store> {
    const body = await request<Envelope<Store>>(`/api/portal/stores/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    });
    return body.data;
  }

  /**
   * Deletes a store.
   *
   * Rejects with a `PortalApiError` carrying the API's own sentence when the
   * store still has tasks — the API answers `409 STORE_HAS_TASKS` with the
   * count, and `request()` already turns that into the message the UI shows.
   * There is deliberately no client-side pre-check: the panel's copy of the
   * store list can be a refresh behind, and refusing on stale data would block
   * a delete that would have succeeded.
   */
  async deleteStore(id: string): Promise<void> {
    await request<Envelope<{ id: string }>>(`/api/portal/stores/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async getTasks(): Promise<Task[]> {
    return this.get<Task[]>('/api/portal/tasks');
  }

  async getSubmissions(statusFilter?: SubmissionStatus | 'all'): Promise<Submission[]> {
    const list = await this.get<Submission[]>('/api/portal/submissions');
    if (!statusFilter || statusFilter === 'all') return list;
    return list.filter((submission) => submission.status === statusFilter);
  }

  /**
   * Creates a briefing and dispatches it.
   *
   * The API turns this into a template and then store tasks, so the returned
   * ids are store-task ids. A briefing sent to three stores produces three
   * tasks, which is why the panel will show more rows than before.
   */
  async createTask(data: {
    title: string;
    description: string;
    reference_image_url: string;
    priority: Task['priority'];
    deadline: string;
    assigned_stores: string[];
    requires_before_after_photo?: boolean;
    checklist_schema?: any[];
  }): Promise<Task> {
    const result = await request<
      Envelope<{ templateId?: string; tasksCreated?: number; taskIds?: string[] }>
    >('/api/portal/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: data.title,
        description: data.description,
        reference_image_url: data.reference_image_url,
        priority: String(data.priority).toUpperCase(),
        deadline: data.deadline,
        assigned_stores: data.assigned_stores,
        requires_before_after_photo: data.requires_before_after_photo ?? false,
        checklist_schema: data.checklist_schema ?? [],
      }),
    });

    // The API turns one briefing into one store task per store, so the id here is
    // the first store task's. It used to be a fabricated `pending-<timestamp>`,
    // which was harmless only because the caller reloads — and would have become
    // a real bug the moment anything used the id.
    const id = result?.data?.taskIds?.[0];
    if (!id) {
      throw new PortalApiError(
        'Tapşırıq yaradıldı, amma heç bir mağazaya göndərilmədi. Mağaza seçimini yoxlayın.',
      );
    }

    return {
      id,
      title: data.title,
      description: data.description,
      reference_image_url: data.reference_image_url,
      priority: data.priority,
      status: 'published',
      deadline: data.deadline,
      created_at: new Date().toISOString(),
      assigned_stores: data.assigned_stores,
      requires_before_after_photo: data.requires_before_after_photo,
      checklist_schema: data.checklist_schema,
    } as Task;
  }

  /**
   * Applies a partial edit to one task.
   *
   * Which keys are sent decides which table is touched: `deadline` and
   * `assigned_user_id` belong to this store's row, everything else belongs to
   * the briefing the row was dispatched from — and is therefore shared with
   * every other store that received it. The API reports how many rows the
   * content change reached, and the caller shows that rather than letting a
   * supervisor believe they renamed one row.
   */
  async updateTask(
    id: string,
    changes: Partial<{
      title: string;
      description: string;
      priority: Task['priority'];
      reference_image_url: string;
      deadline: string;
      assigned_user_id: string | null;
      requires_before_after_photo: boolean;
      checklist_schema: any[];
    }>,
  ): Promise<{ task: Task; templateEditReachedTasks: number }> {
    const body = await request<Envelope<Task> & { templateEditReachedTasks?: number }>(
      `/api/portal/tasks/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(changes) },
    );
    return { task: body.data, templateEditReachedTasks: body.templateEditReachedTasks ?? 0 };
  }

  /**
   * Deletes a task.
   *
   * Rejects with the API's own sentence when the task has submissions, because
   * deleting it cascades to the photos and checklist answers submitted against
   * it. There is deliberately no client-side pre-check: the panel's copy of the
   * task list can be a refresh behind, and its `evidence_count` is only ever a
   * hint — refusing on it would block a delete that would have succeeded.
   */
  async deleteTask(id: string): Promise<void> {
    await request<Envelope<{ id: string }>>(`/api/portal/tasks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async bulkDispatchTasks(data: {
    templateId?: string;
    title: string;
    description: string;
    reference_image_url: string;
    priority: Task['priority'];
    deadline: string;
    chainName?: string;
    storeFormat?: string;
    regionId?: string;
    requires_before_after_photo?: boolean;
  }): Promise<{ success: boolean; count: number; matchedStores: Store[]; tasks: Task[] }> {
    const result = await request<Envelope<any>>('/api/portal/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: data.title,
        description: data.description,
        reference_image_url: data.reference_image_url,
        priority: String(data.priority).toUpperCase(),
        deadline: data.deadline,
        chainName: data.chainName,
        storeFormat: data.storeFormat,
        regionId: data.regionId,
        requires_before_after_photo: data.requires_before_after_photo ?? false,
      }),
    });

    const count = result?.data?.tasksCreated ?? result?.data?.totalStoresMatched ?? 0;

    // Re-read the stores so the caller can show which ones were matched, using
    // the same segmentation the server applied rather than a second guess.
    const stores = await this.getStores();
    const matched = stores.filter((store) => {
      if (!store.is_active) return false;
      if (
        data.chainName &&
        data.chainName !== 'all' &&
        store.chain_name?.toLowerCase() !== data.chainName.toLowerCase()
      ) {
        return false;
      }
      if (
        data.storeFormat &&
        data.storeFormat !== 'all' &&
        store.store_format?.toLowerCase() !== data.storeFormat.toLowerCase()
      ) {
        return false;
      }
      if (data.regionId && data.regionId !== 'all' && store.region_id !== data.regionId) {
        return false;
      }
      return true;
    });

    return { success: true, count, matchedStores: matched, tasks: [] };
  }

  async updateSubmissionStatus(
    id: string,
    status: SubmissionStatus,
    reviewer_feedback?: string,
  ): Promise<Submission | null> {
    await request(`/api/portal/submissions/${encodeURIComponent(id)}/review`, {
      method: 'POST',
      body: JSON.stringify({ status, feedback: reviewer_feedback }),
    });
    return null;
  }

  /**
   * Rule-based auto review.
   *
   * The endpoint scores the signals that actually exist on the record (GPS
   * distance from the store, whether checklist answers came back) and approves
   * or rejects with the reasoning attached. It is deliberately not called a
   * vision model — the shelf-photo analyser lives in the bot process and is not
   * reachable from the API.
   */
  async oneClickAIApprove(id: string): Promise<Submission | null> {
    await request(`/api/portal/submissions/${encodeURIComponent(id)}/auto-approve`, {
      method: 'POST',
    });
    return null;
  }

  /**
   * Reads a chosen image into a data URL.
   *
   * Unchanged in behaviour, and still not an upload: the API has no storage
   * endpoint yet, so the data URL is what gets stored as the reference image.
   * That is fine for a briefing image (kilobytes) and would not be for field
   * photos — the bot submits those as URLs.
   */
  async uploadPlanogramImage(file: File): Promise<string> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        resolve(reader.result as string);
      };
      reader.readAsDataURL(file);
    });
  }
}

export const portalService = new PortalDataService();
