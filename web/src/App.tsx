import React, { useState, useEffect, useRef, useCallback, useReducer } from 'react';
import { Sidebar, TabType } from './components/Sidebar';
import { Header } from './components/Header';
import { DashboardOverview } from './components/DashboardOverview';
import { AuditReviewCenter } from './components/AuditReviewCenter';
import { TaskManager, TaskEditValues } from './components/TaskManager';
import { StoreDirectory, StoreFormValues } from './components/StoreDirectory';
import { PanelLogin } from './components/PanelLogin';
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
import { Store, Task, Submission, DashboardMetrics, TaskPriority } from './types';
import { loadPhaseReducer } from './lib/loadPhase';

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

  const [activeTab, setActiveTab] = useState<TabType>('dashboard');
  const [metrics, setMetrics] = useState<DashboardMetrics>({
    totalStores: 0,
    activeTasks: 0,
    pendingReviews: 0,
    complianceRate: 100,
  });
  // Sıfırlar və `complianceRate: 100` yalnız dolu deyil, həm də YALANŞI ilk
  // paintdir — skelet, məlumat və xəta paneli bu phase-dan asılıdır.
  const [phase, dispatchPhase] = useReducer(loadPhaseReducer, 'loading');
  const [stores, setStores] = useState<Store[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [selectedSubmission, setSelectedSubmission] = useState<Submission | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [reviewInitialFilter, setReviewInitialFilter] = useState<
    'all' | 'pending_review' | 'approved' | 'rejected'
  >('all');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  /* Mobil çekmece + toolbar kölgəsi */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const mainRef = useRef<HTMLElement | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
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
    } catch (error) {
      // The API is unreachable. That is not a reason to show a login form, and
      // not a reason to show an empty dashboard either — the shell renders and
      // `loadData` will report the failure in the usual place.
      setAuth({
        phase: 'ready',
        status: {
          required: false,
          liveKeys: 0,
          bootstrapConfigured: false,
          bootstrapProblem: null,
          detail:
            'Panelin giriş vəziyyəti yoxlanıla bilmədi — ' +
            (error instanceof Error ? error.message : String(error)),
        },
        identity: null,
      });
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

  const loadData = async () => {
    try {
      const [m, s, t, subs] = await Promise.all([
        portalService.getMetrics(),
        portalService.getStores(),
        portalService.getTasks(),
        portalService.getSubmissions('all'),
      ]);
      setMetrics(m);
      setStores(s);
      setTasks(t);
      setSubmissions(subs);
      dispatchPhase({ type: 'loaded' });
    } catch (error) {
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
      showToast(`Məlumat yüklənə bilmədi — ${message}`);
      dispatchPhase({ type: 'failed' });
    }
  };

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  // Loaded only once the shell is allowed to render. Fetching before the gate
  // opens would fire requests that are certain to be refused.
  useEffect(() => {
    if (auth.phase === 'ready') void loadData();
  }, [auth.phase]);

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
  }, [auth.phase]);

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
      showToast(`Əməliyyat alınmadı — ${message}`);
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
    setDrawerOpen(false);
    setScrolled(false);
    mainRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  };

  const handleSignOut = async () => {
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

  const handleAIApproveSubmission = (id: string) =>
    runAction(
      () => portalService.oneClickAIApprove(id),
      'Rəf auditi avtomatik yoxlama əsasında qərarlandı!',
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

  const handleCreateTask = (taskData: {
    title: string;
    description: string;
    reference_image_url: string;
    priority: TaskPriority;
    deadline: string;
    assigned_stores: string[];
    requires_before_after_photo?: boolean;
    checklist_schema?: any[];
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
    setSelectedSubmission(sub);
    setReviewInitialFilter('all');
    handleTabChange('review');
  };

  const handleNavigateToReview = (
    filter: 'all' | 'pending_review' | 'approved' | 'rejected' = 'all',
  ) => {
    setReviewInitialFilter(filter);
    handleTabChange('review');
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

      {/* Bildiriş — şüşə popover */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="glass-pop fixed bottom-4 right-4 z-[60] flex items-center gap-2.5
                     max-w-[calc(100vw-2rem)] rounded-[14px] px-4 py-3
                     text-[12px] font-bold text-ink animate-toastIn"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-ok flex-shrink-0" />
          <span>{toastMessage}</span>
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
      <div className="relative z-10 flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header
          activeTab={activeTab}
          onOpenCreateTask={handleOpenCreateTask}
          onOpenDrawer={() => setDrawerOpen(true)}
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
              {activeTab === 'dashboard' && (
                <DashboardOverview
                  phase={phase}
                  metrics={metrics}
                  recentSubmissions={submissions.slice(0, 6)}
                  onRetry={() => {
                    dispatchPhase({ type: 'retry' });
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

              {activeTab === 'review' && (
                <AuditReviewCenter
                  submissions={submissions}
                  selectedSubmission={selectedSubmission}
                  setSelectedSubmission={setSelectedSubmission}
                  onApprove={handleApproveSubmission}
                  onAIApprove={handleAIApproveSubmission}
                  onReject={handleRejectSubmission}
                  initialFilter={reviewInitialFilter}
                />
              )}

              {activeTab === 'tasks' && (
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

              {activeTab === 'stores' && (
                <StoreDirectory
                  stores={stores}
                  submissions={submissions}
                  onCreate={handleCreateStore}
                  onUpdate={handleUpdateStore}
                  onDelete={handleDeleteStore}
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
