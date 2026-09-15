/**
 * oneTeam Supervisor Portal — panel authentication
 * ============================================================================
 *
 * Holds the panel's own credential and talks to `/api/panel`.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * The panel used to have no credential of its own. nginx attached
 * `oneteam-user:usr-admin-001` at the edge to every `/api/portal/` request, so
 * the browser never held a secret — good — but anyone who reached the URL was
 * an administrator, and every audit in the database was attributed to the same
 * seeded user.
 *
 * Now each person has a key. It is stored here and attached as the bearer on
 * every request, and nginx prefers it over the injected one (see the map at the
 * top of nginx.conf).
 *
 * WHY localStorage AND NOT A COOKIE
 * ---------------------------------
 * A cookie would be sent automatically by the browser to every path on the
 * origin, including the static assets, and would need CSRF protection to be
 * safe. This key is read by JavaScript and attached by JavaScript, only to
 * `/api/` — which is a narrower rule, and the narrower rule is the right one
 * for a credential.
 *
 * The trade-off is honest and worth stating: a key in `localStorage` is readable
 * by any script that ends up running on this origin. That is why the key is
 * revocable, per-person and shown once — a leak costs one person's access and is
 * cut off with one click, rather than costing everyone's.
 */

const STORAGE_KEY = 'oneteam-panel-key';

/** Same reasoning as portalApi: empty means same-origin, through the nginx proxy. */
const API_BASE =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_BASE_URL) || '';

/**
 * The key, held in memory as well as in storage.
 *
 * `localStorage` throws in some privacy modes rather than returning null, and a
 * panel that silently loses the key on every navigation is unusable in a way
 * that looks like a server problem. The in-memory copy keeps the session alive
 * for as long as the tab is open, and `storageWorks` records whether the key
 * will survive a reload so the UI can say so.
 */
let memoryKey: string | null = null;
let storageWorks = true;

function readStorage(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    storageWorks = false;
    return null;
  }
}

export function storedKey(): string | null {
  if (memoryKey) return memoryKey;
  const fromStorage = readStorage();
  if (fromStorage) memoryKey = fromStorage;
  return memoryKey;
}

export function storeKey(key: string): void {
  memoryKey = key;
  try {
    window.localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Kept in memory only. The session works until the tab is closed.
    storageWorks = false;
  }
}

export function clearStoredKey(): void {
  memoryKey = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do — memory is already clear */
  }
}

/** Whether the key survives a page reload. Surfaced in the UI when it does not. */
export function keyIsPersistent(): boolean {
  return storageWorks;
}

/**
 * The `Authorization` header for a panel request, or nothing.
 *
 * Returned as an object so callers can spread it into a header set — an absent
 * key must mean an absent header, not `Bearer undefined`, which the API would
 * reject with a confusing message.
 */
export function panelAuthHeaders(): Record<string, string> {
  const key = storedKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** A failure the UI can show. `status` distinguishes "wrong key" from "server down". */
export class PanelAuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'PanelAuthError';
  }
}

interface Envelope<T> {
  success: boolean;
  data: T;
}

async function panelRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...panelAuthHeaders(),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new PanelAuthError(
      `API-yə qoşulmaq mümkün olmadı (${url}). Şəbəkəni yoxlayın.`,
      undefined,
      'NETWORK',
    );
  }

  const text = await response.text();
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new PanelAuthError(
      `API gözlənilməz cavab qaytardı (HTTP ${response.status})`,
      response.status,
      'BAD_RESPONSE',
    );
  }

  if (!response.ok) {
    // Nest's exception filter puts the message at different depths depending on
    // whether the body came from a `throw` or a filter. Reading all three is
    // cheaper than getting an empty error message in production.
    const detail =
      payload?.message ?? payload?.error?.message ?? payload?.error ?? payload?.data?.message;
    throw new PanelAuthError(
      Array.isArray(detail) ? detail.join('; ') : String(detail ?? response.statusText),
      response.status,
      typeof payload?.error === 'string' ? payload.error : undefined,
    );
  }

  return (payload as Envelope<T>).data;
}

export interface PanelAuthStatus {
  /** Whether the panel should ask for a key at all. */
  required: boolean;
  liveKeys: number;
  bootstrapConfigured: boolean;
  /** A sentence explaining the state, written by the API so both agree. */
  detail: string;
  /** Set when a configured bootstrap key is being refused (too short). */
  bootstrapProblem: string | null;
}

export interface PanelIdentity {
  userId: string;
  fullName: string | null;
  email: string | null;
  role: string;
  via: string;
  canManageKeys: boolean;
  /** Signed in with the bootstrap key rather than a personal one. */
  usingBootstrapKey: boolean;
}

export interface PanelKeyRow {
  hashPrefix: string;
  userId: string;
  userName: string | null;
  label: string | null;
  createdBy: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  live: boolean;
  current: boolean;
}

export interface PanelUserRow {
  id: string;
  fullName: string;
  email: string | null;
  role: string;
  liveKeys: number;
}

/** Why a person cannot be removed. `null` means the delete is expected to work. */
export type UserBlockReason = 'SELF' | 'LAST_ADMIN' | 'HAS_SUBMISSIONS' | 'UNKNOWN';

/** A person, as the user-management screen needs them. */
export interface ManagedUserRow {
  id: string;
  fullName: string;
  /** Null when the address was synthesised to satisfy `NOT NULL`. */
  email: string | null;
  role: string;
  phone: string | null;
  /** Which channel registered them, or null when the panel or the seed did. */
  joinedVia: 'telegram' | 'mobile' | null;
  liveKeys: number;
  /** Null when the count could not be read — not the same as zero. */
  submissions: number | null;
  isSelf: boolean;
  deletable: boolean;
  blockedBy: UserBlockReason | null;
}

/**
 * Whether the panel is configured to require a key.
 *
 * Public — this is the call the login screen makes before it has a key, so it
 * must not send one and must not fail when it has none.
 */
export async function fetchAuthStatus(): Promise<PanelAuthStatus> {
  return panelRequest<PanelAuthStatus>('/api/panel/auth-status');
}

/** Who the stored key belongs to. This is also the "is my key valid" probe. */
export async function fetchIdentity(): Promise<PanelIdentity> {
  return panelRequest<PanelIdentity>('/api/panel/me');
}

/**
 * Signs out.
 *
 * The server revokes the presented key, so signing out of one browser does not
 * sign the same person out of another. The local copy is cleared even if the
 * call fails: leaving a key in `localStorage` because the network was down would
 * mean "sign out" did not sign out.
 */
export async function signOut(): Promise<void> {
  try {
    await panelRequest('/api/panel/logout', { method: 'POST' });
  } finally {
    clearStoredKey();
  }
}

export async function fetchKeys(): Promise<{ keys: PanelKeyRow[]; users: PanelUserRow[] }> {
  return panelRequest<{ keys: PanelKeyRow[]; users: PanelUserRow[] }>('/api/panel/keys');
}

/**
 * Mints a key. The returned value is the only copy that will ever exist.
 *
 * `hashPrefix` is the identifier the key list and the audit log use, so the row
 * this call created can be pointed at without re-reading the list.
 */
export async function mintKey(
  userId: string,
  label?: string,
): Promise<{ token: string; hashPrefix: string; userId: string; label: string | null }> {
  return panelRequest('/api/panel/keys', {
    method: 'POST',
    body: JSON.stringify({ userId, label }),
  });
}

export async function revokeKey(hashPrefix: string): Promise<void> {
  await panelRequest(`/api/panel/keys/${encodeURIComponent(hashPrefix)}/revoke`, {
    method: 'POST',
  });
}

export async function revokeUserKeys(userId: string): Promise<number> {
  const result = await panelRequest<{ revoked: number }>(
    `/api/panel/users/${encodeURIComponent(userId)}/revoke-keys`,
    { method: 'POST' },
  );
  return result.revoked;
}

/**
 * Everybody, with what the screen needs to decide about them.
 *
 * `deletable` and `blockedBy` are computed by the API rather than here. The
 * rule is `ON DELETE RESTRICT` on `task_evidences.submitted_by_id` plus the
 * last-administrator rule, and a rule the browser re-implements is a rule that
 * drifts from the one the server enforces.
 */
export async function fetchUsers(): Promise<{
  users: ManagedUserRow[];
  roles: string[];
  adminCount: number;
}> {
  return panelRequest<{ users: ManagedUserRow[]; roles: string[]; adminCount: number }>(
    '/api/panel/users',
  );
}

export async function createUser(input: {
  fullName: string;
  email?: string;
  role: string;
  phone?: string;
}): Promise<{ id: string; fullName: string; email: string | null; role: string }> {
  return panelRequest('/api/panel/users', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateUser(
  userId: string,
  changes: { fullName?: string; role?: string; phone?: string },
): Promise<{ id: string; fullName: string; role: string; phone: string | null }> {
  return panelRequest(`/api/panel/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify(changes),
  });
}

export async function deleteUser(userId: string): Promise<void> {
  await panelRequest(`/api/panel/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}
