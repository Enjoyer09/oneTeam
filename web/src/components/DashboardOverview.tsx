import React from 'react';
import {
  Store,
  ClipboardCheck,
  Clock,
  TrendingUp,
  ArrowUpRight,
  Inbox,
  AlertTriangle,
} from 'lucide-react';
import { DashboardMetrics, Submission, SubmissionStatus, Task } from '../types';
import { TabType } from './Sidebar';
import { LoadPhase } from '../lib/loadPhase';
import { StatusBadge } from './ui/StatusBadge';
import { taskIsOverdue } from '../lib/taskQueue';

interface DashboardOverviewProps {
  phase: LoadPhase;
  metrics: DashboardMetrics;
  recentSubmissions: Submission[];
  tasks: Task[];
  submissionCount: number;
  loadedAt: Date | null;
  onRetry: () => void;
  onOpenSubmissionReview: (submission: Submission) => void;
  onNavigateTab: (tab: TabType, filter?: SubmissionStatus | 'all') => void;
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({
  phase,
  metrics,
  recentSubmissions,
  tasks,
  submissionCount,
  loadedAt,
  onRetry,
  onOpenSubmissionReview,
  onNavigateTab,
}) => {
  // İlk paint heç vaxt sıfır KPI + "%100 uyğunluq" göstərməməlidir — bu,
  // yüklənənə qədər YALAN rəqəmdir. Yüklənmə → skelet, uğursuzluq → xəta.
  if (phase === 'loading') return <DashboardSkeleton />;
  if (phase === 'error') return <DashboardLoadError onRetry={onRetry} />;

  const overdueTasks = tasks.filter((task) => taskIsOverdue(task));

  const kpiCards = [
    {
      title: 'Tərəfdaş Mağazalar',
      value: metrics.totalStores,
      subtitle: 'Aktiv retail nöqtələri',
      icon: Store,
      tint: 'rgba(91,91,234,.14)',
      ink: '#4b4bd8',
      acc: 'rgba(91,91,234,.20)',
      action: () => onNavigateTab('stores'),
    },
    {
      title: 'Aktiv tapşırıqlar',
      value: metrics.activeTasks,
      subtitle: 'Cari yoxlama təlimatları',
      icon: ClipboardCheck,
      tint: 'var(--coke-soft)',
      ink: 'var(--coke)',
      acc: 'rgba(244,0,9,.18)',
      action: () => onNavigateTab('tasks'),
    },
    {
      title: 'Yoxlama Gözləyən',
      value: metrics.pendingReviews,
      subtitle: 'Təsdiq tələb edən rəf fotoları',
      icon: Clock,
      tint: 'var(--warn-bg)',
      ink: 'var(--warn)',
      acc: 'rgba(245,158,11,.22)',
      highlight: metrics.pendingReviews > 0,
      action: () => onNavigateTab('review', 'pending_review'),
    },
    {
      title: 'Rəf uyğunluğu',
      value: submissionCount === 0 ? '—' : `${metrics.complianceRate}%`,
      subtitle:
        submissionCount === 0
          ? 'Hələ audit yoxdur'
          : `${submissionCount} göndərişdən təsdiqlənən pay`,
      icon: TrendingUp,
      tint: 'var(--ok-bg)',
      ink: 'var(--ok)',
      acc: 'rgba(16,185,129,.20)',
      action: () => onNavigateTab('review', 'approved'),
    },
  ];

  // §10.4 canonical badge — ailə/etiket xəritəsi `lib/statusMap` (§11) saxlayır.
  const statusBadge = (status: Submission['status']) => <StatusBadge value={status} />;

  const scoreTone = (score: number) => (score >= 80 ? 'st-ok' : score >= 60 ? 'st-warn' : 'st-bad');

  return (
    <div className="stagger-g flex flex-col gap-4 sm:gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <p>İdarəetmə icmalı · Gözləyən qərarlar və gecikən işlər</p>
        {loadedAt && (
          <p role="status">
            Məlumat yeniləndi:{' '}
            {loadedAt.toLocaleString('az-AZ', {
              timeZone: 'Asia/Baku',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
        )}
      </div>
      {/* ── Əsas göstəricilər ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4 lg:gap-3.5">
        {kpiCards.map((kpi, idx) => {
          const Icon = kpi.icon;
          return (
            <div
              key={idx}
              role="button"
              tabIndex={0}
              onClick={kpi.action}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  kpi.action();
                }
              }}
              className={[
                'glass-card glass-lift relative overflow-hidden rounded-card p-3.5 lg:p-4 cursor-pointer select-none text-left transition-all',
                'focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)] hover:border-coke/40',
                kpi.highlight ? 'ring-2 ring-[var(--warn-bd)]' : '',
              ].join(' ')}
              title={`${kpi.title} bölməsinə keç`}
            >
              {/* Küncdəki rəngli işıq ləkəsi */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -bottom-16 -right-12 h-[150px] w-[150px] rounded-full"
                style={{ background: `radial-gradient(circle, ${kpi.acc}, transparent 70%)` }}
              />

              <div className="relative flex items-start justify-between gap-2">
                <span className="text-xs font-extrabold uppercase tracking-[.05em] text-muted leading-tight">
                  {kpi.title}
                </span>
                <span
                  className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[9px]"
                  style={{ backgroundColor: kpi.tint, color: kpi.ink }}
                >
                  <Icon className="w-4 h-4" strokeWidth={2} />
                </span>
              </div>

              <div className="relative mt-2.5">
                <div className="text-[26px] lg:text-[30px] font-extrabold leading-none tracking-[-.045em] text-ink tabular-nums">
                  {kpi.value}
                </div>
                <p className="mt-1 text-[11px] text-muted leading-snug">{kpi.subtitle}</p>
              </div>
            </div>
          );
        })}
      </div>

      <section className="grid gap-3 md:grid-cols-2" aria-label="İndi görüləcək işlər">
        <button
          type="button"
          onClick={() => onNavigateTab('review', 'pending_review')}
          className="glass-card rounded-card p-4 text-left hover:border-amber-400 focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)]"
        >
          <span className="text-xs font-bold uppercase tracking-wide text-muted">
            Audit qərarları
          </span>
          <span className="mt-1 block text-2xl font-extrabold text-ink">
            {metrics.pendingReviews}
          </span>
          <span className="text-sm text-ink-2">
            {metrics.pendingReviews
              ? 'Sübutları yoxla və qərar ver →'
              : 'Hazırda gözləyən audit yoxdur'}
          </span>
        </button>
        <button
          type="button"
          onClick={() => onNavigateTab('tasks')}
          className="glass-card rounded-card p-4 text-left hover:border-rose-400 focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)]"
        >
          <span className="text-xs font-bold uppercase tracking-wide text-muted">
            Gecikən tapşırıqlar
          </span>
          <span className="mt-1 block text-2xl font-extrabold text-ink">{overdueTasks.length}</span>
          <span className="text-sm text-ink-2">
            {overdueTasks.length
              ? `${overdueTasks[0].title} və digərləri →`
              : 'Gecikən aktiv tapşırıq yoxdur'}
          </span>
        </button>
      </section>

      {/* ── Son göndərişlər ───────────────────────────────────────────────── */}
      <div className="glass-card overflow-hidden rounded-card">
        <div className="flex items-start justify-between gap-3 p-4 pb-3">
          <div className="min-w-0">
            <h3 className="text-[13.5px] font-extrabold tracking-[-.02em] text-ink">
              Son Göndərilən Rəf Yoxlamaları
            </h3>
            <p className="mt-0.5 text-[11px] text-muted">
              Telegram Bot və Mobil tətbiqdən daxil olan audit axını
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigateTab('review')}
            className="flex flex-none items-center gap-1 text-[11.5px] font-extrabold text-coke
                       transition-opacity hover:opacity-75"
          >
            <span className="hidden sm:inline">Bütün fotolara bax</span>
            <span className="sm:hidden">Hamısı</span>
            <ArrowUpRight className="w-3.5 h-3.5" strokeWidth={2.2} />
          </button>
        </div>

        {recentSubmissions.length === 0 ? (
          /* Boş vəziyyət — istifadəçi nə gözlədiyini və nə edəcəyini bilir */
          <div className="flex flex-col items-center gap-2.5 px-6 py-12 text-center">
            <span
              className="grid h-12 w-12 place-items-center rounded-[14px]"
              style={{ backgroundColor: 'var(--g-panel)', color: 'var(--faint)' }}
            >
              <Inbox className="w-6 h-6" strokeWidth={1.7} />
            </span>
            <h4 className="text-[13px] font-extrabold text-ink">Hələ heç bir audit gəlməyib</h4>
            <p className="max-w-[38ch] text-[11.5px] text-muted">
              Sahə heyəti foto göndərən kimi yoxlamalar avtomatik burada görünəcək.
            </p>
          </div>
        ) : (
          <div className="reflow-scroll overflow-x-auto px-2 pb-2.5 sm:px-3">
            <table className="tbl-g reflow reflow-dash lg:min-w-[860px]">
              <thead>
                <tr>
                  <th>Foto</th>
                  <th>Rəf tapşırığı</th>
                  <th>Mağaza</th>
                  <th>Təmsilçi</th>
                  <th>Vaxt</th>
                  <th>AI Balı</th>
                  <th>Status</th>
                  <th className="text-right">Əməliyyat</th>
                </tr>
              </thead>
              <tbody>
                {recentSubmissions.map((sub) => {
                  const dateStr = new Date(sub.submitted_at).toLocaleString('az-AZ', {
                    timeZone: 'Asia/Baku',
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  });
                  return (
                    <tr key={sub.id}>
                      <td>
                        <button
                          type="button"
                          onClick={() => onOpenSubmissionReview(sub)}
                          aria-label="Rəf fotosunu müqayisə et"
                          className="h-11 w-11 overflow-hidden rounded-[10px] border border-hair
                                     transition-transform duration-150 hover:scale-[1.06] active:scale-95"
                        >
                          <img
                            src={sub.photo_url}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        </button>
                      </td>

                      <td>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="text-[12px] font-bold leading-tight tracking-[-.015em] text-ink">
                            {sub.task?.title || 'Rəf Auditi'}
                          </p>
                        </div>
                        <span className="mt-0.5 block text-[11px] capitalize text-muted">
                          {sub.task?.priority} prioritet
                        </span>
                      </td>

                      <td>
                        <b className="block text-[12px] font-bold tracking-[-.01em] text-ink">
                          {sub.store?.name || 'Mağaza'}
                        </b>
                        <span className="mt-0.5 block font-mono text-[11px] text-muted">
                          {sub.store?.store_code}
                        </span>
                      </td>

                      <td className="text-ink-2">
                        {sub.submitter_name || sub.metadata?.telegram_username || 'Merchandiser'}
                      </td>

                      <td className="font-mono text-[11px] text-muted">{dateStr}</td>

                      <td>
                        {sub.ai_score !== undefined && sub.ai_score !== null ? (
                          <span
                            className={`grid h-[34px] w-[34px] place-items-center rounded-[11px] border
                                        text-[12.5px] font-extrabold tracking-[-.02em] tabular-nums
                                        ${scoreTone(sub.ai_score)}`}
                          >
                            {sub.ai_score}
                          </span>
                        ) : (
                          <span className="text-[11px] text-muted">—</span>
                        )}
                      </td>

                      <td>{statusBadge(sub.status)}</td>

                      <td className="text-right">
                        <button
                          type="button"
                          onClick={() => onOpenSubmissionReview(sub)}
                          className="btn-g"
                        >
                          Müqayisə et
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

/** KPI kartlarının geometriyasını köçürən skelet — formularda sıfır yoxdur. */
function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4 sm:gap-5" aria-busy="true">
      <span role="status" className="sr-only">
        Göstəricilər yüklənir…
      </span>
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4 lg:gap-3.5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="glass-card animate-pulse rounded-card p-3.5 lg:p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="h-3 w-24 rounded-md bg-muted/25" />
              <div className="h-[30px] w-[30px] rounded-[9px] bg-muted/20" />
            </div>
            <div className="mt-3 h-7 w-16 rounded-md bg-muted/30" />
            <div className="mt-2 h-3 w-32 rounded-md bg-muted/20" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Yükləmə uğursuzsa: susmaq yox, söz + yenidən cəhd düyməsi. */
function DashboardLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="glass-card flex flex-col items-center gap-3 rounded-card p-8 text-center"
    >
      <AlertTriangle className="h-6 w-6 text-[var(--warn)]" strokeWidth={2} />
      <p className="text-sm font-extrabold text-ink">Məlumat yüklənə bilmədi</p>
      <p className="text-[13px] text-muted">Bağlantını yoxlayın və yenidən cəhd edin.</p>
      <button
        type="button"
        onClick={onRetry}
        className="btn-coke mt-1 whitespace-nowrap rounded-xl px-3.5 py-2.5 text-xs font-extrabold text-white transition-all"
      >
        Yenidən yoxla
      </button>
    </div>
  );
}
