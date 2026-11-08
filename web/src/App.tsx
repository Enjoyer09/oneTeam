import React, { useState, useEffect, useRef, useCallback, useReducer } from 'react';
import { Sidebar, TabType } from './components/Sidebar';
import { Header } from './components/Header';
import { DashboardOverview } from './components/DashboardOverview';
import { AuditReviewCenter } from './components/AuditReviewCenter';
import { TaskManager, TaskEditValues } from './components/TaskManager';
import { StoreDirectory, StoreFormValues } from './components/StoreDirectory';
import { ProductCatalog, ProductFormValues } from './components/ProductCatalog';
import { ShelfMap, ShelfFormValues } from './components/ShelfMap';
import { PanelLogin } from './components/PanelLogin';
import { ChecklistItem } from './types';
import { PanelKeysModal } from './components/PanelKeysModal';
import { PanelUsersModal } from './components/PanelUsersModal';
import { portalService, PortalApiError } from './lib/portalApi';
import {
  fetchAuthStatus,
  fetchIdentity,
  signOut as signOutPanel,
  clearStoredKey,
  storedKey,
  type PanelAuthStatus,
  type PanelIdentity,
} from './lib/panelAuth';
import {
  Store,
  Task,
  Submission,
  DashboardMetrics,
  TaskPriority,
  Product,
  ShelfPosition,
  ShelfMetrics,
} from './types';
import { loadPhaseReducer, type LoadPhase } from './lib/loadPhase';

/**
 * The two questions the shell has to answer before it can render anything:
 * does this deployment want a key, and does the browser have one that works.
 *
 * They are separate states rather than one boolean because the situations need
 * different words on screen. "Open" is not the same as "signed in", and saying
 * so is the whole point of this change — the panel used to be open and nobody
 * was told.
 */
type AuthState =
  | { phase: 'checking' }
  | { phase: 'unavailable' }
  | { phase: 'login'; status: PanelAuthStatus }
  | { phase: 'ready'; status: PanelAuthStatus; identity: PanelIdentity | null };

/** A 401 or 403 from the portal API means the credential, not the network. */
function isAuthFailure(error: unknown): boolean {
  return error instanceof PortalApiError && (error.status === 401 || error.status === 403);
}

export function App() {
  const [auth, setAuth] = useState<AuthState>({ phase: 'checking' });
  const [keysOpen, setKeysOpen] = useState(false);
  const [usersOpen, setUsersOpen] = useState(false);

  const tabFromPath = (): TabType => {
    const path = window.location.pathname;
    if (path.startsWith('/reviews')) return 'review';
    if (path.startsWith('/tasks')) return 'tasks';
    if (path.startsWith('/stores')) return 'stores';
    if (path.startsWith('/products')) return 'products';
    if (path.startsWith('/shelf-plan')) return 'shelfmap';
    return 'dashboard';
  };
  const [activeTab, setActiveTab] = useState<TabType>(tabFromPath);
  const [metrics, setMetrics] = useState<DashboardMetrics>({
    totalStores: 0,
    activeTasks: 0,
    pendingReviews: 0,
    complianceRate: 100,
  });
  // Sıfırlar və `complianceRate: 100` yalnız dolu deyil, həm də YALANŞI ilk
  // paintdir — skelet, məlumat və xəta paneli bu phase-dan asılıdır.
  const [phase, dispatchPhase] = useReducer(loadPhaseReducer, 'loading');
  const [tabPhases, setTabPhases] = useState<Record<TabType, LoadPhase>>({
    dashboard: 'loading',
    review: 'loading',
    tasks: 'loading',
    stores: 'loading',
    products: 'loading',
    shelfmap: 'loading',
  });
  const activePhase = activeTab === 'dashboard' ? phase : tabPhases[activeTab];
  const [stores, setStores] = useState<Store[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [shelfPositions, setShelfPositions] = useState<ShelfPosition[]>([]);
  const [shelfMetrics, setShelfMetrics] = useState<ShelfMetrics | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const [selectedSubmission, setSelectedSubmission] = useState<Submission | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [reviewInitialFilter, setReviewInitialFilter] = useState<
    'all' | 'pending_review' | 'approved' | 'rejected'
  >(() => {
    const status = new URLSearchParams(window.location.search).get('status');
    return status === 'pending_review' || status === 'approved' || status === 'rejected'
      ? status
      : 'pending_review';
  });
  const [toast, setToast] = useState<{ msg: string; kind: 'success' | 'error' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Mobil çekmece + toolbar kölgəsi */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const mainRef = useRef<HTMLElement | null>(null);

  const showToast = (msg: string, kind: 'success' | 'error' = 'success') => {
    // Əvvəlki toast-ın taymeri yenisini vaxtından əvvəl silməsin.
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, kind });
    // Xəta oxunmalıdır, nəzərdən qaçmamalıdır — uğurdan uzun qalır.
    toastTimer.current = setTimeout(() => setToast(null), kind === 'error' ? 6000 : 3500);
  };

  /**
   * Asks the API whether a key is needed, and whether the one in this browser
   * is any good.
   *
   * Called on mount and after anything that could change the answer — signing
   * out, minting the first key, a rejected request. Deliberately not cached: it
   * is one small request, and a stale answer here is a panel that either shows a
   * login screen it does not need or hides one it does.
   */
  const checkAuth = useCallback(async () => {
    setAuth({ phase: 'checking' });

    let status: PanelAuthStatus;
    try {
      status = await fetchAuthStatus();
    } catch {
      // Unknown authentication is neither an open panel nor a rejected login.
      setAuth({ phase: 'unavailable' });
      return;
    }

    if (!status.required) {
      // Still ask who we are. In the open state the caller is whoever the edge
      // supplied, and knowing the role is what decides whether the key
      // management button is offered — without it, the first key could only be
      // created by someone who already had a key, which is a circle.
      try {
        const identity = await fetchIdentity();
        setAuth({ phase: 'ready', status, identity });
      } catch {
        setAuth({ phase: 'ready', status, identity: null });
      }
      return;
    }

    if (!storedKey()) {
      setAuth({ phase: 'login', status });
      return;
    }

    try {
      const identity = await fetchIdentity();
      setAuth({ phase: 'ready', status, identity });
    } catch (error) {
      // A key that is stored but rejected is worse than no key at all: it would
      // be sent on every request and fail every one of them. Dropped here so the
      // person sees a login screen rather than a dashboard full of errors.
      if (isAuthFailure(error)) {
        clearStoredKey();
        setAuth({ phase: 'login', status });
        return;
      }
      setAuth({
        phase: 'ready',
        status,
        identity: null,
      });
    }
  }, []);

  const loadData = useCallback(async () => {
    try {
      const results = await Promise.allSettled([
        portalService.getMetrics(),
        portalService.getStores(),
        portalService.getTasks(),
        portalService.getSubmissions('all'),
        portalService.getProducts(),
        portalService.getShelfPositions(),
        portalService.getShelfMetrics(),
      ] as const);
      for (const result of results) {
        if (result.status === 'rejected' && isAuthFailure(result.reason)) throw result.reason;
      }
      const [m, s, t, subs, prods, shelf, shelfM] = results;
      if (m.status === 'fulfilled') setMetrics(m.value);
      if (s.status === 'fulfilled') setStores(s.value);
      if (t.status === 'fulfilled') setTasks(t.value);
      if (subs.status === 'fulfilled') setSubmissions(subs.value);
      if (prods.status === 'fulfilled') setProducts(prods.value);
      if (shelf.status === 'fulfilled') setShelfPositions(shelf.value);
      if (shelfM.status === 'fulfilled') setShelfMetrics(shelfM.value);
      const state = (...indices: number[]): LoadPhase =>
        indices.every((i) => results[i].status === 'fulfilled') ? 'ready' : 'error';
      const next = {
        dashboard: state(0, 2, 3),
        review: state(3),
        tasks: state(1, 2),
        stores: state(1, 3),
        products: state(4),
        shelfmap: state(4, 5, 6),
      };
      setTabPhases(next);
      if (next.dashboard === 'ready') setLastLoadedAt(new Date());
      dispatchPhase({ type: next.dashboard === 'ready' ? 'loaded' : 'failed' });
    } catch (error) {
      setTabPhases({
        dashboard: 'error',
        review: 'error',
        tasks: 'error',
        stores: 'error',
        products: 'error',
        shelfmap: 'error',
      });
      // A rejected credential is not a data problem and must not be reported as
      // one — the remedy is to sign in, not to retry. Everything else falls
      // through to the honest-failure path below.
      if (isAuthFailure(error)) {
        const hadKey = storedKey() !== null;
        clearStoredKey();
        // Açar yox ikən yenidən yoxlama heç nəyi dəyişmir: `ready` → `checking`
        // → `ready` osillasiyası effect-i yenidən işə salır və loadData
        // sonsuz 401 döngüsünə girir (açar mövcud olanda bu yol düzgündür —
        // köhnə açar təmizlənir və giriş ekranı açılır).
        // ponytail: açarsız 403 (panel ortada konfiqurasiya olunubsa) sadəcə
        // xəta paneli göstərir; reload/login axını bunu həll edər.
        if (hadKey) {
          await checkAuth();
        } else {
          dispatchPhase({ type: 'failed' });
        }
        return;
      }

      // Sükutla boş ekran göstərmək ən pis nəticədir. Əvvəl bu panel saxta
      // Supabase-dən oxuyurdu və heç vaxt uğursuz olmurdu — yəni həmişə
      // "işləyirdi", sadəcə yanlış məlumatla.
      const message = error instanceof Error ? error.message : String(error);
      console.error('⛔ [oneTeam Portal] Məlumat yüklənə bilmədi:', message);
      showToast(`Məlumat yüklənə bilmədi — ${message}`, 'error');
      dispatchPhase({ type: 'failed' });
    }
  }, [checkAuth]);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  // Loaded only once the shell is allowed to render. Fetching before the gate
  // opens would fire requests that are certain to be refused.
  useEffect(() => {
    if (auth.phase === 'ready') void loadData();
  }, [auth.phase, loadData]);

  // Gün ərzində açıq qalan portal boot-anın rəqəmlərini göstərməməlidir —
  // tab-a qayıdanda (və başqa supervisor işləyəndə) rəqəmlər yenilənir.
  useEffect(() => {
    if (auth.phase !== 'ready') return;
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadData();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [auth.phase, loadData]);

  /**
   * Yazma əməliyyatlarını vahid şəkildə sarır: xəta olsa istifadəçi görür,
   * olsa da ekran yenilənir. Hər handler-də təkrar try/catch yazmaq əvəzinə
   * bir yerdə saxlanılır.
   *
   * NƏTİCƏNİ QAYTARIR — bu, bu funksiyanın ən vacib hissəsidir.
   *
   * Keçmişdə `Promise<void>` idi və xətanı udub normal qayıdırdı. Bunun
   * komponentlər üçün görünməz bir nəticəsi var idi: `await onApprove(id)`
   * səhv olanda da "uğurla bitdi" sayılırdı, ona görə `setSelectedSubmission(null)`
   * işləyirdi — istifadəçi 500 qaytarmış bir sorğunu uğur kimi görüb, modal
   * bağlanmış və yeni auditi açmış vəziyyətdə qalırdı. Eyni səbəb `TaskManager`-də
   * **yazılmış formu** silirdi: `handleSubmit` uğursuzluqda da modalı bağlayıb
   * `setTitle('')`/`setDescription('')` çağırırdı.
   *
   * İndi `true` = əməliyyat də edildi, `false` = xəta var idi (toxunulan
   * `showToast` eynidir). Çağıran yalnız uğurluqda "uzağa atılacaq" işləri —
   * modalı bağlamaq, formu təmizləmək, yazılmış mətni silmək — aparır.
   */
  const runAction = async (action: () => Promise<unknown>, successMessage: string) => {
    try {
      await action();
      await loadData();
      // Boş mesaj "artıq öz bildirişini göstərən" əməliyyatlar üçündür —
      // məsələn kütləvi göndərmə, hansı ki sayı özü bildirir.
      if (successMessage) showToast(successMessage);
      return true;
    } catch (error) {
      if (isAuthFailure(error)) {
        clearStoredKey();
        await checkAuth();
        return false;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error('⛔ [oneTeam Portal] Əməliyyat alınmadı:', message);
      showToast(`Əməliyyat alınmadı — ${message}`, 'error');
      return false;
    }
  };

  /**
   * `runAction`-ın modal içindəki formalar üçün variantı.
   *
   * Fərq təkdir: xəta **yenidən atılır**. `runAction` onu toast-a çevirib
   * udur, bu isə formanın öz içinə ötürür — çünki "bu kod artıq istifadə
   * olunur" kimi bir səbəb istifadəçinin baxdığı yerin yanında görünməlidir,
   * 3 saniyə sonra yox olan bir zolaqda yox.
   */
  const runFormAction = async (action: () => Promise<unknown>, successMessage: string) => {
    try {
      await action();
    } catch (error) {
      if (isAuthFailure(error)) {
        clearStoredKey();
        await checkAuth();
      }
      throw error;
    }
    await loadData();
    if (successMessage) showToast(successMessage);
  };

  /* Escape çekmeceni bağlayır — istifadəçi həmişə çıxış yolu görür */
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  /* Tab dəyişəndə məzmunu yuxarı qaytar — istifadəçi yeni ekranın başından başlayır */
  const handleTabChange = (tab: TabType) => {
    setActiveTab(tab);
    const routes: Record<TabType, string> = {
      dashboard: '/',
      review: '/reviews',
      tasks: '/tasks',
      stores: '/stores',
      products: '/products',
      shelfmap: '/shelf-plan',
    };
    window.history.pushState({}, '', routes[tab]);
    setSelectedSubmission(null);
    setDrawerOpen(false);
    setScrolled(false);
    mainRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  };

  const setReviewSelection = (submission: Submission | null) => {
    setSelectedSubmission(submission);
    if (submission) {
      window.history.pushState(
        { oneTeamReview: true },
        '',
        `/reviews/${encodeURIComponent(submission.id)}${window.location.search}`,
      );
    } else if (window.location.pathname.startsWith('/reviews/')) {
      setSelectedSubmission(null);
      if (window.history.state?.oneTeamReview === true) window.history.back();
      else window.history.replaceState({}, '', `/reviews${window.location.search}`);
    }
  };

  useEffect(() => {
    const restoreRoute = () => {
      const tab = tabFromPath();
      setActiveTab(tab);
      const match = window.location.pathname.match(/^\/reviews\/([^/]+)$/);
      const id = match ? decodeURIComponent(match[1]) : null;
      setSelectedSubmission(id ? (submissions.find((item) => item.id === id) ?? null) : null);
      const status = new URLSearchParams(window.location.search).get('status');
      if (tab === 'review' && ['pending_review', 'approved', 'rejected'].includes(status ?? '')) {
        setReviewInitialFilter(status as 'pending_review' | 'approved' | 'rejected');
      }
    };
    window.addEventListener('popstate', restoreRoute);
    restoreRoute();
    return () => window.removeEventListener('popstate', restoreRoute);
  }, [submissions]);

  const handleSignOut = async () => {
    try {
      window.sessionStorage.removeItem('oneteam-task-draft-v1');
    } catch {
      // Private browsing may disable storage; sign-out still proceeds.
    }
    try {
      await signOutPanel();
    } catch (error) {
      // The key is cleared locally even when the call fails — see panelAuth.
      console.error('⛔ [oneTeam Portal] Çıxış bildirişi göndərilə bilmədi:', error);
    }
    setStores([]);
    setTasks([]);
    setSubmissions([]);
    setSelectedSubmission(null);
    await checkAuth();
  };

  const handleApproveSubmission = (id: string) =>
    runAction(
      () => portalService.updateSubmissionStatus(id, 'approved'),
      'Rəf auditi uğurla təsdiqləndi!',
    );

  const handleRejectSubmission = (id: string, feedback: string) =>
    runAction(
      () => portalService.updateSubmissionStatus(id, 'rejected', feedback),
      'İmtina qərarı və təlimat supervayzer tərəfindən qeydə alındı.',
    );

  /**
   * Mağaza yazma əməliyyatları.
   *
   * Koordinatlar formada mətn kimi saxlanılır (boş sahə `''` oxunur, `0` yox),
   * API-yə isə rəqəm kimi gedir — çevirmə burada, sərhəddə edilir.
   */
  const handleCreateStore = (form: StoreFormValues) =>
    runFormAction(
      () =>
        portalService.createStore({
          store_code: form.store_code,
          name: form.name,
          address: form.address,
          latitude: Number(form.latitude),
          longitude: Number(form.longitude),
          city: form.city,
          chain_name: form.chain_name,
          store_format: form.store_format,
          is_active: form.is_active,
        }),
      'Yeni mağaza yaradıldı.',
    );

  const handleUpdateStore = (id: string, changes: Partial<Store>) =>
    runFormAction(() => portalService.updateStore(id, changes), 'Mağaza məlumatları yeniləndi.');

  const handleDeleteStore = (id: string) =>
    runFormAction(() => portalService.deleteStore(id), 'Mağaza silindi.');

  /**
   * Məhsul (SKU) kataloqu əməliyyatları — dalğa 1.2.
   *
   * Forma yalnız boş olmayan sahələri göndərir (size/variant undefined),
   * beləliklə PATCH "sahəni boşaltmaq" ilə "sahəni oxumamaq"ı seçir.
   */
  const handleCreateProduct = (form: ProductFormValues) =>
    runFormAction(
      () =>
        portalService.createProduct({
          barcode: form.barcode,
          name: form.name,
          size: form.size.trim() || undefined,
          variant: form.variant.trim() || undefined,
        }),
      'Yeni məhsul kataloqa əlavə olundu.',
    );

  const handleUpdateProduct = (id: string, changes: Partial<Product>) =>
    runFormAction(() => portalService.updateProduct(id, changes), 'Məhsul məlumatları yeniləndi.');

  const handleDeleteProduct = (id: string) =>
    runFormAction(() => portalService.deleteProduct(id), 'Məhsul silindi.');

  /**
   * Rəf xəritəsi əməliyyatları — dalğa 1.3.
   *
   * level/position artıq rəqəmdir (komponentdə təsdiqdə parse olunub);
   * product_id boş string boş mövqedir — null göndərilir ki PATCH
   * "təyini silmək" ilə "toxunmamaq"ı seçsin.
   */
  const handleCreateShelfPosition = (form: ShelfFormValues) =>
    runFormAction(
      () =>
        portalService.createShelfPosition({
          section: form.section.trim(),
          level: Number(form.level),
          position: Number(form.position),
          product_id: form.product_id || null,
        }),
      'Yeni rəf mövqesi xəritəyə əlavə olundu.',
    );

  const handleUpdateShelfPosition = (id: string, changes: Partial<ShelfPosition>) =>
    runFormAction(() => portalService.updateShelfPosition(id, changes), 'Rəf mövqesi yeniləndi.');

  const handleDeleteShelfPosition = (id: string) =>
    runFormAction(() => portalService.deleteShelfPosition(id), 'Rəf mövqesi silindi.');

  /**
   * Əl sayımı (dalğa 1.4) — roldan asılı deyil: saymaq işçinin öz işidir,
   * xəritə redaktəsi isə ayrıca qapıdadır (requireShelfEditor).
   */
  const handleCountShelfPosition = (id: string, units: number) =>
    runFormAction(() => portalService.countShelfPosition(id, units), 'Sayım qeyd olundu.');

  const handleCreateTask = (taskData: {
    title: string;
    description: string;
    reference_image_url: string;
    priority: TaskPriority;
    deadline: string;
    assigned_stores: string[];
    requires_before_after_photo?: boolean;
    checklist_schema?: ChecklistItem[];
  }) =>
    runAction(
      () => portalService.createTask(taskData),
      'Yeni planogram təlimatı mağazalara uğurla göndərildi!',
    );

  /**
   * Tapşırıq redaktəsi.
   *
   * Xəta **yenidən atılır** (udulmur): səbəb modalın içində, istifadəçinin
   * baxdığı yerin yanında görünməlidir — "bu tapşırığa 3 audit göndərişi var"
   * kimi bir cümlə toast-da itməməlidir.
   *
   * Uğur mesajı isə API-dən gələn rəqəmə bağlıdır: başlıq, təsvir, prioritet və
   * çeklist təlimatın üzərindədir, ondan göndərilmiş hər mağaza onları oxuyur.
   * Səssizcə dörd kartı dəyişmək istifadəçini çaşdırardı.
   */
  const handleUpdateTask = async (id: string, changes: TaskEditValues) => {
    try {
      const { templateEditReachedTasks } = await portalService.updateTask(id, changes);
      await loadData();
      showToast(
        templateEditReachedTasks > 1
          ? `Tapşırıq yeniləndi — məzmun dəyişikliyi ${templateEditReachedTasks} mağazaya tətbiq olundu.`
          : 'Tapşırıq yeniləndi.',
      );
      return templateEditReachedTasks;
    } catch (error) {
      if (isAuthFailure(error)) {
        clearStoredKey();
        await checkAuth();
      }
      throw error;
    }
  };

  const handleDeleteTask = async (id: string) => {
    try {
      await portalService.deleteTask(id);
      await loadData();
      showToast('Tapşırıq silindi.');
    } catch (error) {
      if (isAuthFailure(error)) {
        clearStoredKey();
        await checkAuth();
      }
      throw error;
    }
  };

  const handleBulkDispatch = (bulkData: {
    title: string;
    description: string;
    reference_image_url: string;
    priority: TaskPriority;
    deadline: string;
    chainName: string;
    storeFormat: string;
    regionId: string;
    requires_before_after_photo?: boolean;
  }) =>
    runAction(async () => {
      const result = await portalService.bulkDispatchTasks(bulkData);
      // Sayı serverdən gəlir, ona görə mesaj "nə qədər mağazaya getdi" sualına
      // uydurma rəqəm yox, real cavab verir.
      showToast(
        `Kütləvi Təlimat: ${result.count} hədəf mağazaya və sahə merchandiser-lərinə uğurla göndərildi!`,
      );
    }, '');

  const openSubmissionFromDashboard = (sub: Submission) => {
    handleTabChange('review');
    setReviewInitialFilter('all');
    setReviewSelection(sub);
  };

  const handleNavigateToReview = (
    filter: 'all' | 'pending_review' | 'approved' | 'rejected' = 'all',
  ) => {
    setReviewInitialFilter(filter);
    handleTabChange('review');
    if (filter !== 'all') window.history.replaceState({}, '', `/reviews?status=${filter}`);
  };

  const handleOpenCreateTask = () => {
    handleTabChange('tasks');
    setIsCreateModalOpen(true);
  };

  /**
   * Mağaza/tapşırıq yaratmaq, redaktə etmək və silmək hüququ olan istifadəçi.
   *
   * Bu, **yalnız UI** qərarıdır — düymələri göstərmək və ya gizlətmək üçün.
   * Əsl qapı API-dədir (`STORE_EDIT_FORBIDDEN` / `TASK_EDIT_FORBIDDEN`, 403),
   * çünki brauzerdəki bir şərt heç vaxt təhlükəsizlik sərhədi deyil.
   *
   * `identity` null ola bilər (şəxsiyyət sorğusu alınmadı). O halda rol
   * bilinmir, ona görə imtiyazlı əməliyyat **təklif olunmur**: bilinməyəni
   * "bəlkə admin" kimi oxumaq səhv tərəfə yıxılmaq olardı.
   */
  const canEditMasterData =
    auth.phase === 'ready' &&
    (auth.identity?.role === 'ADMIN' || auth.identity?.role === 'SUPERVISOR');

  // ---------------------------------------------------------------------------
  // Before the shell
  // ---------------------------------------------------------------------------

  if (auth.phase === 'checking') {
    return (
      <div className="relative flex h-screen items-center justify-center text-ink">
        <div className="bg-scene" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <b />
        </div>
        <p className="relative z-10 text-[12px] text-muted">Giriş vəziyyəti yoxlanılır…</p>
      </div>
    );
  }

  if (auth.phase === 'unavailable') {
    return (
      <div className="min-h-screen grid place-items-center p-6 bg-white text-slate-900">
        <div role="alert" className="max-w-md text-center space-y-4">
          <h1 className="text-xl font-bold">Giriş vəziyyəti yoxlanıla bilmədi</h1>
          <p>Bağlantını yoxlayıb yenidən cəhd edin. Giriş məlumatlarınız saxlanılıb.</p>
          <button className="btn-g btn-g-primary" onClick={() => void checkAuth()}>
            Yenidən yoxla
          </button>
        </div>
      </div>
    );
  }

  if (auth.phase === 'login') {
    // The prop is typed `() => void`; `checkAuth` is async, so the promise is
    // detached explicitly rather than handed on as a return value nobody reads.
    return <PanelLogin status={auth.status} onSignedIn={() => void checkAuth()} />;
  }

  /**
   * The panel is open: no key exists and none is required. Said out loud rather
   * than left implicit — this state is the reason the login was worth adding,
   * and a person looking at it should know that anyone with the address is
   * looking at the same thing.
   */
  const openWarning = !auth.status.required;

  return (
    <div className="relative flex h-screen overflow-hidden text-ink">
      {/* Şüşənin içindən görünən rəngli fon */}
      <div className="bg-scene" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <b />
      </div>

      {/* Telefon: çekmece açıq olanda fonun üstünə yumşaq pərdə */}
      {drawerOpen && (
        <button
          type="button"
          aria-label="Menyunu bağla"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-30 bg-[rgba(10,16,32,.34)] backdrop-blur-[2px]
                     animate-[viewIn_250ms_cubic-bezier(.22,1,.36,1)_both] md:hidden"
        />
      )}

      {/* Bildiriş — şüşə popover. Xəta qırmızı nöqtə + role="alert" ilə gəlir:
          yaşıl "ok" nöqtəsi ilə uğur kimi görünmür. */}
      {toast && (
        <div
          role={toast.kind === 'error' ? 'alert' : 'status'}
          aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
          className="glass-pop fixed bottom-4 right-4 z-[60] flex items-center gap-2.5
                     max-w-[calc(100vw-2rem)] rounded-[14px] px-4 py-3
                     text-[12px] font-bold text-ink animate-toastIn"
        >
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${toast.kind === 'error' ? 'bg-bad' : 'bg-ok'}`}
          />
          <span>{toast.msg}</span>
        </div>
      )}

      {keysOpen && (
        <PanelKeysModal onClose={() => setKeysOpen(false)} onChanged={() => void checkAuth()} />
      )}
      {usersOpen && (
        <PanelUsersModal onClose={() => setUsersOpen(false)} onChanged={() => void checkAuth()} />
      )}

      {/* Yan panel */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={handleTabChange}
        pendingCount={metrics.pendingReviews}
        identity={auth.identity}
        drawerOpen={drawerOpen}
        onCloseDrawer={() => setDrawerOpen(false)}
      />

      {/* Əsas sahə */}
      <div
        id="oneteam-content"
        className="relative z-10 flex-1 flex flex-col min-w-0 overflow-hidden"
      >
        <Header
          activeTab={activeTab}
          onOpenCreateTask={handleOpenCreateTask}
          onOpenDrawer={() => setDrawerOpen(true)}
          drawerOpen={drawerOpen}
          scrolled={scrolled}
          identity={auth.identity}
          onSignOut={() => void handleSignOut()}
          onOpenKeys={() => setKeysOpen(true)}
          onOpenUsers={() => setUsersOpen(true)}
        />

        {/* Açıq panel xəbərdarlığı — vəziyyəti gizlətmək onu təhlükəli edir */}
        {openWarning && (
          <div className="relative z-20 flex flex-shrink-0 items-start gap-2.5 border-b border-[rgba(200,60,60,.24)] bg-[rgba(200,60,60,.08)] px-4 py-2.5 sm:px-5">
            <span className="mt-[3px] h-2 w-2 flex-shrink-0 rounded-full bg-[#b23b3b]" />
            <p className="text-[11.5px] leading-relaxed text-ink">
              <b className="font-extrabold text-[#b23b3b]">Panel açıqdır.</b> Hələ heç bir giriş
              açarı yoxdur, ona görə bu səhifəni aça bilən hər kəs məlumatları görür və dəyişə
              bilər.{' '}
              <button
                type="button"
                onClick={() => setKeysOpen(true)}
                className="font-bold underline underline-offset-2"
              >
                İlk açarı yaradın
              </button>{' '}
              — o andan giriş tələb olunacaq.
            </p>
          </div>
        )}

        <main
          ref={mainRef}
          onScroll={(e) => setScrolled((e.target as HTMLElement).scrollTop > 4)}
          className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6 sm:py-6 lg:px-7"
        >
          <div className="mx-auto w-full max-w-[1360px]">
            {/* key = tab → hər keçiddə yumşaq giriş animasiyası yenidən işə düşür */}
            <div key={activeTab} className="view-g">
              {(activeTab === 'dashboard' || activePhase !== 'ready') && (
                <DashboardOverview
                  phase={activePhase}
                  metrics={metrics}
                  recentSubmissions={submissions.slice(0, 6)}
                  tasks={tasks}
                  submissionCount={submissions.length}
                  loadedAt={lastLoadedAt}
                  onRetry={() => {
                    dispatchPhase({ type: 'retry' });
                    setTabPhases((prev) => ({ ...prev, [activeTab]: 'loading' }));
                    void loadData();
                  }}
                  onOpenSubmissionReview={openSubmissionFromDashboard}
                  onNavigateTab={(tab, filter) => {
                    if (tab === 'review') {
                      handleNavigateToReview(filter || 'all');
                    } else {
                      handleTabChange(tab);
                    }
                  }}
                />
              )}

              {activePhase === 'ready' && activeTab === 'review' && (
                <AuditReviewCenter
                  submissions={submissions}
                  selectedSubmission={selectedSubmission}
                  setSelectedSubmission={setReviewSelection}
                  onApprove={handleApproveSubmission}
                  onReject={handleRejectSubmission}
                  initialFilter={reviewInitialFilter}
                />
              )}

              {activePhase === 'ready' && activeTab === 'tasks' && (
                <TaskManager
                  tasks={tasks}
                  stores={stores}
                  isCreateModalOpen={isCreateModalOpen}
                  setIsCreateModalOpen={setIsCreateModalOpen}
                  onCreateTask={handleCreateTask}
                  onBulkDispatch={handleBulkDispatch}
                  onUpdateTask={handleUpdateTask}
                  onDeleteTask={handleDeleteTask}
                  canEdit={canEditMasterData}
                />
              )}

              {activePhase === 'ready' && activeTab === 'stores' && (
                <StoreDirectory
                  stores={stores}
                  submissions={submissions}
                  onCreate={handleCreateStore}
                  onUpdate={handleUpdateStore}
                  onDelete={handleDeleteStore}
                  canEdit={canEditMasterData}
                />
              )}

              {activePhase === 'ready' && activeTab === 'products' && (
                <ProductCatalog
                  products={products}
                  onCreate={handleCreateProduct}
                  onUpdate={handleUpdateProduct}
                  onDelete={handleDeleteProduct}
                  canEdit={canEditMasterData}
                />
              )}

              {activePhase === 'ready' && activeTab === 'shelfmap' && (
                <ShelfMap
                  shelfPositions={shelfPositions}
                  metrics={shelfMetrics}
                  products={products}
                  onCreate={handleCreateShelfPosition}
                  onUpdate={handleUpdateShelfPosition}
                  onDelete={handleDeleteShelfPosition}
                  onCount={handleCountShelfPosition}
                  canEdit={canEditMasterData}
                />
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
export default App;
