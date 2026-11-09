import React, { useMemo, useState } from 'react';
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
  submissions: Submission[];
  tasks: Task[];
  loadedAt: Date | null;
  onRetry: () => void;
  onOpenSubmissionReview: (submission: Submission) => void;
  onNavigateTab: (tab: TabType, filter?: SubmissionStatus | 'all') => void;
}

const DAY_MS = 86_400_000;

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({
  phase,
  metrics,
  submissions,
  tasks,
  loadedAt,
  onRetry,
  onOpenSubmissionReview,
  onNavigateTab,
}) => {
  const [range, setRange] = useState<7 | 30>(7);

  // Audit axını — real göndərişlərdən hesablanan gündəlik sayğac. Uydurma
  // trend yoxdur: hər sütun həmin gün daxil olan fotoların sayıdır.
  const days = useMemo(() => {
    const now = Date.now();
    const buckets = Array.from({ length: range }, (_, i) => {
      const d = new Date(now - (range - 1 - i) * DAY_MS);
      return {
        key: d.toISOString().slice(0, 10),
        label: d.toLocaleDateString('az-AZ', { day: '2-digit', month: '2-digit' }),
        weekday: d.toLocaleDateString('az-AZ', { weekday: 'short' }),
        count: 0,
      };
    });
    const index = new Map(buckets.map((b, i) => [b.key, i]));
    for (const s of submissions) {
      const i = index.get((s.submitted_at ?? '').slice(0, 10));
      if (i !== undefined) buckets[i].count += 1;
    }
    return buckets;
  }, [submissions, range]);

  const maxCount = Math.max(1, ...days.map((d) => d.count));
  const rangeTotal = days.reduce((sum, d) => sum + d.count, 0);

  const approved = submissions.filter((s) => s.status === 'approved').length;
  const pending = submissions.filter((s) => s.status === 'pending_review').length;
  const rejected = submissions.filter((s) => s.status === 'rejected').length;
  const total = submissions.length;
  const rate = metrics.complianceRate;
  const overdueTasks = tasks.filter((task) => taskIsOverdue(task));

  // İlk paint heç vaxt sıfır KPI + "%100 uyğunluq" göstərməməlidir.
  if (phase === 'loading') return <DashboardSkeleton />;
  if (phase === 'error') return <DashboardLoadError onRetry={onRetry} />;

  const kpiCards = [
    {
      title: 'Tərəfdaş Mağazalar',
      value: metrics.totalStores,
      subtitle: 'Aktiv retail nöqtələri',
      icon: Store,
      bg: 'var(--primary-soft)',
      fg: 'var(--primary)',
      chip: null,
      action: () => onNavigateTab('stores'),
    },
    {
      title: 'Aktiv tapşırıqlar',
      value: metrics.activeTasks,
      subtitle: 'Cari yoxlama təlimatları',
      icon: ClipboardCheck,
      bg: 'var(--accent-soft)',
      fg: 'var(--accent-ink)',
      chip:
        overdueTasks.length > 0 ? (
          <span className="delta-chip delta-bad">{overdueTasks.length} gecikmiş</span>
        ) : null,
      action: () => onNavigateTab('tasks'),
    },
    {
      title: 'Yoxlama Gözləyən',
      value: metrics.pendingReviews,
      subtitle: 'Təsdiq tələb edən rəf fotoları',
      icon: Clock,
      bg: 'var(--cyan-soft)',
      fg: 'var(--cyan)',
      chip:
        metrics.pendingReviews > 0 ? (
          <span className="delta-chip delta-warn">qərar gözləyir</span>
        ) : null,
      action: () => onNavigateTab('review', 'pending_review'),
    },
    {
      title: 'Rəf uyğunluğu',
      value: total === 0 ? '—' : `${rate}%`,
      subtitle: total === 0 ? 'Hələ audit yoxdur' : `${total} göndərişdən təsdiqlənən pay`,
      icon: TrendingUp,
      bg: 'var(--ok-bg)',
      fg: 'var(--ok)',
      chip:
        total > 0 ? (
          <span className={`delta-chip ${rate >= 80 ? '' : 'delta-warn'}`}>{approved} təsdiq</span>
        ) : null,
      action: () => onNavigateTab('review', 'approved'),
    },
  ];

  const statusBadge = (status: Submission['status']) => <StatusBadge value={status} />;
  const scoreTone = (score: number) => (score >= 80 ? 'st-ok' : score >= 60 ? 'st-warn' : 'st-bad');

  const R = 52;
  const C = 2 * Math.PI * R;
  const frac = total === 0 ? 0 : Math.min(1, Math.max(0, rate / 100));
  const recentSubmissions = submissions.slice(0, 6);

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

      {/* ── Əsas göstəricilər ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
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
              className="glass-card glass-lift rounded-card p-4 lg:p-5 cursor-pointer select-none text-left
                         focus:outline-none focus:ring-2 focus:ring-[var(--primary-ring)]"
              title={`${kpi.title} bölməsinə keç`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-[14px] font-bold text-muted leading-tight">{kpi.title}</span>
                <span
                  className="grid h-10 w-10 flex-none place-items-center rounded-[14px]"
                  style={{ backgroundColor: kpi.bg, color: kpi.fg }}
                >
                  <Icon className="w-5 h-5" strokeWidth={2} />
                </span>
              </div>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <span className="text-[30px] lg:text-[34px] font-extrabold leading-none tracking-[-.04em] text-ink tabular-nums">
                  {kpi.value}
                </span>
                {kpi.chip}
              </div>
              <p className="mt-2 text-[13.5px] text-muted leading-snug">{kpi.subtitle}</p>
            </div>
          );
        })}
      </div>

      {/* ── Axın qrafiki + uyğunluq halqası ── */}
      <section className="grid gap-4 lg:grid-cols-3" aria-label="Audit statistikası">
        <div className="glass-card rounded-card p-5 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-[16px] font-extrabold tracking-[-.02em] text-ink">Audit axını</h3>
            <div className="seg" role="group" aria-label="Zaman aralığı">
              <button
                type="button"
                className="seg-item"
                aria-pressed={range === 7}
                onClick={() => setRange(7)}
              >
                7 gün
              </button>
              <button
                type="button"
                className="seg-item"
                aria-pressed={range === 30}
                onClick={() => setRange(30)}
              >
                30 gün
              </button>
            </div>
          </div>

          <div className="mt-4 flex items-end gap-2">
            <span className="text-[28px] font-extrabold leading-none tracking-[-.03em] text-ink tabular-nums">
              {rangeTotal}
            </span>
            <span className="delta-chip delta-neutral mb-0.5">göndəriş</span>
          </div>

          <div className="mt-5">
            <div className="flex items-end gap-1.5 h-[160px]">
              {days.map((d) => (
                <div
                  key={d.key}
                  className="flex h-full min-w-0 flex-1 flex-col items-center justify-end"
                  title={`${d.label}: ${d.count} göndəriş`}
                >
                  {d.count > 0 && (
                    <span className="mb-1 rounded-full border border-hair bg-[var(--g-card)] px-1.5 py-[1px] text-[11.5px] font-extrabold text-ink shadow-subtle tabular-nums">
                      {d.count}
                    </span>
                  )}
                  <div
                    className="w-full max-w-[28px] rounded-full transition-[height] duration-300 ease-out"
                    style={{
                      height: `${(d.count / maxCount) * 100}%`,
                      minHeight: d.count > 0 ? '10px' : '4px',
                      backgroundColor: d.count > 0 ? 'var(--primary)' : 'var(--g-panel)',
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-2 flex gap-1.5">
              {days.map((d, i) => {
                const show = range === 7 || i % 5 === 0 || i === days.length - 1;
                return (
                  <span key={d.key} className="flex-1 truncate text-center text-[11px] text-muted">
                    {show ? (range === 7 ? d.weekday : d.label) : ''}
                  </span>
                );
              })}
            </div>
          </div>
        </div>

        <div className="glass-card flex flex-col rounded-card p-5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[16px] font-extrabold tracking-[-.02em] text-ink">Uyğunluq</h3>
            <span className="chip-g">canlı</span>
          </div>

          <div className="relative mx-auto my-5 h-[150px] w-[150px]">
            <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
              <circle cx="60" cy="60" r={R} fill="none" stroke="var(--g-panel)" strokeWidth="12" />
              <circle
                cx="60"
                cy="60"
                r={R}
                fill="none"
                stroke="var(--ok-dot)"
                strokeWidth="12"
                strokeLinecap="round"
                strokeDasharray={`${frac * C} ${C}`}
              />
            </svg>
            <div className="absolute inset-0 grid place-items-center">
              <div className="text-center">
                <div className="text-[30px] font-extrabold leading-none tracking-[-.03em] text-ink tabular-nums">
                  {total === 0 ? '—' : `${rate}%`}
                </div>
                <div className="mt-1 text-[12px] text-muted">təsdiq payı</div>
              </div>
            </div>
          </div>

          <div className="grid gap-2.5">
            {[
              { label: 'Təsdiqləndi', count: approved, dot: 'var(--ok-dot)' },
              { label: 'Gözləyir', count: pending, dot: 'var(--warn-dot)' },
              { label: 'İmtina edildi', count: rejected, dot: 'var(--bad-dot)' },
            ].map((row) => (
              <div key={row.label} className="flex items-center gap-2 text-[14px]">
                <span
                  className="h-2.5 w-2.5 flex-none rounded-full"
                  style={{ backgroundColor: row.dot }}
                />
                <span className="flex-1 text-ink-2">{row.label}</span>
                <span className="font-extrabold text-ink tabular-nums">{row.count}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Son göndərişlər ── */}
      <div className="glass-card overflow-hidden rounded-card">
        <div className="flex items-start justify-between gap-3 p-5 pb-3">
          <div className="min-w-0">
            <h3 className="text-[16px] font-extrabold tracking-[-.02em] text-ink">
              Son Göndərilən Rəf Yoxlamaları
            </h3>
            <p className="mt-0.5 text-[13.5px] text-muted">
              Telegram Bot və Mobil tətbiqdən daxil olan audit axını
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigateTab('review')}
            className="flex flex-none items-center gap-1 text-[14px] font-extrabold text-primary
                       transition-opacity hover:opacity-75"
          >
            <span className="hidden sm:inline">Bütün fotolara bax</span>
            <span className="sm:hidden">Hamısı</span>
            <ArrowUpRight className="w-3.5 h-3.5" strokeWidth={2.2} />
          </button>
        </div>

        {recentSubmissions.length === 0 ? (
          <div className="flex flex-col items-center gap-2.5 px-6 py-12 text-center">
            <span
              className="grid h-12 w-12 place-items-center rounded-[14px]"
              style={{ backgroundColor: 'var(--g-panel)', color: 'var(--faint)' }}
            >
              <Inbox className="w-6 h-6" strokeWidth={1.7} />
            </span>
            <h4 className="text-[15px] font-extrabold text-ink">Hələ heç bir audit gəlməyib</h4>
            <p className="max-w-[38ch] text-[13.5px] text-muted">
              Sahə heyəti foto göndərən kimi yoxlamalar avtomatik burada görünəcək.
            </p>
          </div>
        ) : (
          <div className="reflow-scroll overflow-x-auto px-3 pb-3">
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
                          className="h-11 w-11 overflow-hidden rounded-[12px] border border-hair
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
                        <p className="text-[14.5px] font-bold leading-tight tracking-[-.015em] text-ink">
                          {sub.task?.title || 'Rəf Auditi'}
                        </p>
                        <span className="mt-0.5 block text-[13px] capitalize text-muted">
                          {sub.task?.priority} prioritet
                        </span>
                      </td>
                      <td>
                        <b className="block text-[14.5px] font-bold tracking-[-.01em] text-ink">
                          {sub.store?.name || 'Mağaza'}
                        </b>
                        <span className="mt-0.5 block font-mono text-[13px] text-muted">
                          {sub.store?.store_code}
                        </span>
                      </td>
                      <td className="text-ink-2">
                        {sub.submitter_name || sub.metadata?.telegram_username || 'Merchandiser'}
                      </td>
                      <td className="font-mono text-[13px] text-muted">{dateStr}</td>
                      <td>
                        {sub.ai_score !== undefined && sub.ai_score !== null ? (
                          <span
                            className={`grid h-[34px] w-[34px] place-items-center rounded-[12px] border
                                        text-[14.5px] font-extrabold tracking-[-.02em] tabular-nums
                                        ${scoreTone(sub.ai_score)}`}
                          >
                            {sub.ai_score}
                          </span>
                        ) : (
                          <span className="text-[13px] text-muted">—</span>
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
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="glass-card animate-pulse rounded-card p-4 lg:p-5">
            <div className="flex items-start justify-between gap-2">
              <div className="h-3 w-24 rounded-md bg-muted/25" />
              <div className="h-10 w-10 rounded-[14px] bg-muted/20" />
            </div>
            <div className="mt-3 h-8 w-16 rounded-md bg-muted/30" />
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
      <p className="text-[15px] text-muted">Bağlantını yoxlayın və yenidən cəhd edin.</p>
      <button
        type="button"
        onClick={onRetry}
        className="btn-primary mt-1 whitespace-nowrap rounded-xl px-3.5 py-2.5 text-xs font-extrabold text-white transition-all"
      >
        Yenidən yoxla
      </button>
    </div>
  );
}
