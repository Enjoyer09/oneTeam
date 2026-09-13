import React, { useState, useEffect, useRef } from 'react';
import { Sidebar, TabType } from './components/Sidebar';
import { Header } from './components/Header';
import { DashboardOverview } from './components/DashboardOverview';
import { AuditReviewCenter } from './components/AuditReviewCenter';
import { TaskManager } from './components/TaskManager';
import { StoreDirectory } from './components/StoreDirectory';
import { portalService } from './lib/supabase';
import { Store, Task, Submission, DashboardMetrics, TaskPriority } from './types';

export function App() {
  const [activeTab, setActiveTab] = useState<TabType>('dashboard');
  const [metrics, setMetrics] = useState<DashboardMetrics>({
    totalStores: 0,
    activeTasks: 0,
    pendingReviews: 0,
    complianceRate: 100,
  });
  const [stores, setStores] = useState<Store[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [selectedSubmission, setSelectedSubmission] = useState<Submission | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  /* Mobil çekmece + toolbar kölgəsi */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const mainRef = useRef<HTMLElement | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const loadData = async () => {
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
  };

  useEffect(() => {
    loadData();
  }, []);

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

  const handleApproveSubmission = async (id: string) => {
    await portalService.updateSubmissionStatus(id, 'approved');
    await loadData();
    showToast('Rəf auditi uğurla təsdiqləndi!');
  };

  const handleAIApproveSubmission = async (id: string) => {
    await portalService.oneClickAIApprove(id);
    await loadData();
    showToast('Rəf auditi AI təhlili əsasında avtomatik təsdiqləndi!');
  };

  const handleRejectSubmission = async (id: string, feedback: string) => {
    await portalService.updateSubmissionStatus(id, 'rejected', feedback);
    await loadData();
    showToast('İmtina qərarı və təlimat supervayzer tərəfindən qeydə alındı.');
  };

  const handleCreateTask = async (taskData: {
    title: string;
    description: string;
    reference_image_url: string;
    priority: TaskPriority;
    deadline: string;
    assigned_stores: string[];
    requires_before_after_photo?: boolean;
    checklist_schema?: any[];
  }) => {
    await portalService.createTask(taskData);
    await loadData();
    showToast('Yeni planogram təlimatı mağazalara uğurla göndərildi!');
  };

  const handleBulkDispatch = async (bulkData: {
    title: string;
    description: string;
    reference_image_url: string;
    priority: TaskPriority;
    deadline: string;
    chainName: string;
    storeFormat: string;
    regionId: string;
    requires_before_after_photo?: boolean;
  }) => {
    const result = await portalService.bulkDispatchTasks(bulkData);
    await loadData();
    showToast(
      `Kütləvi Təlimat: ${result.count} hədəf mağazaya və sahə merchandiser-lərinə uğurla göndərildi!`
    );
  };

  const openSubmissionFromDashboard = (sub: Submission) => {
    setSelectedSubmission(sub);
    handleTabChange('review');
  };

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
          className="glass-pop fixed top-4 right-4 z-[60] flex items-center gap-2.5
                     max-w-[calc(100vw-2rem)] rounded-[14px] px-4 py-3
                     text-[12px] font-bold text-ink animate-toastIn"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-ok flex-shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Yan panel */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={handleTabChange}
        pendingCount={metrics.pendingReviews}
        drawerOpen={drawerOpen}
        onCloseDrawer={() => setDrawerOpen(false)}
      />

      {/* Əsas sahə */}
      <div className="relative z-10 flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header
          activeTab={activeTab}
          onOpenCreateTask={() => setIsCreateModalOpen(true)}
          onOpenDrawer={() => setDrawerOpen(true)}
          scrolled={scrolled}
        />

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
                  metrics={metrics}
                  recentSubmissions={submissions.slice(0, 6)}
                  onOpenSubmissionReview={openSubmissionFromDashboard}
                  onNavigateTab={handleTabChange}
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
                />
              )}

              {activeTab === 'stores' && (
                <StoreDirectory stores={stores} submissions={submissions} />
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
export default App;
