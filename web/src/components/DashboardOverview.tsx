import React from 'react';
import {
  Store,
  ClipboardCheck,
  Clock,
  TrendingUp,
  Camera,
  ArrowUpRight,
  Inbox,
} from 'lucide-react';
import { DashboardMetrics, Submission } from '../types';

interface DashboardOverviewProps {
  metrics: DashboardMetrics;
  recentSubmissions: Submission[];
  onOpenSubmissionReview: (submission: Submission) => void;
  onNavigateTab: (tab: any) => void;
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({
  metrics,
  recentSubmissions,
  onOpenSubmissionReview,
  onNavigateTab,
}) => {
  const kpiCards = [
    {
      title: 'Tərəfdaş Mağazalar',
      value: metrics.totalStores,
      subtitle: 'Aktiv retail nöqtələri',
      icon: Store,
      tint: 'rgba(91,91,234,.14)',
      ink: '#4b4bd8',
      acc: 'rgba(91,91,234,.20)',
    },
    {
      title: 'Aktiv Planogramlar',
      value: metrics.activeTasks,
      subtitle: 'Cari yoxlama təlimatları',
      icon: ClipboardCheck,
      tint: 'var(--coke-soft)',
      ink: 'var(--coke)',
      acc: 'rgba(244,0,9,.18)',
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
    },
    {
      title: 'Planogram Uyğunluğu',
      value: `${metrics.complianceRate}%`,
      subtitle: 'Təsdiqlənmiş rəf dərəcəsi',
      icon: TrendingUp,
      tint: 'var(--ok-bg)',
      ink: 'var(--ok)',
      acc: 'rgba(16,185,129,.20)',
    },
  ];

  const statusBadge = (status: Submission['status']) => {
    switch (status) {
      case 'pending_review':
        return (
          <span className="st-g st-warn">
            <span className="dot" />
            Gözləyir
          </span>
        );
      case 'approved':
        return (
          <span className="st-g st-ok">
            <span className="dot" />
            Təsdiqləndi
          </span>
        );
      case 'rejected':
        return (
          <span className="st-g st-bad">
            <span className="dot" />
            İmtina edildi
          </span>
        );
      default:
        return null;
    }
  };

  /* Ssenari çipi — rəng + işarə + mətn birlikdə (yalnız rəngə güvənmirik) */
  const scenarioChip = (sub: Submission) => {
    const scenario = sub.metadata?.scenario;
    if (scenario === 'scenario_a_compliant')
      return <span className="chip-g chip-a">Ssenari A</span>;
    if (scenario === 'scenario_b_gap') return <span className="chip-g chip-b">Ssenari B</span>;
    if (scenario === 'scenario_c_missing_sprite')
      return <span className="chip-g chip-c">Ssenari C</span>;
    return null;
  };

  const scoreTone = (score: number) => (score >= 80 ? 'st-ok' : score >= 60 ? 'st-warn' : 'st-bad');

  return (
    <div className="stagger-g flex flex-col gap-4 sm:gap-5">
      {/* ── Əsas göstəricilər ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4 lg:gap-3.5">
        {kpiCards.map((kpi, idx) => {
          const Icon = kpi.icon;
          return (
            <div
              key={idx}
              className={[
                'glass-card glass-lift relative overflow-hidden rounded-card p-3.5 lg:p-4',
                kpi.highlight ? 'ring-2 ring-[var(--warn-bd)]' : '',
              ].join(' ')}
            >
              {/* Küncdəki rəngli işıq ləkəsi */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -bottom-16 -right-12 h-[150px] w-[150px] rounded-full"
                style={{ background: `radial-gradient(circle, ${kpi.acc}, transparent 70%)` }}
              />

              <div className="relative flex items-start justify-between gap-2">
                <span className="text-[10px] lg:text-[10.5px] font-extrabold uppercase tracking-[.05em] text-muted leading-tight">
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
                <p className="mt-1 text-[10.5px] text-muted leading-snug">{kpi.subtitle}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Diqqət tələb edən banner ──────────────────────────────────────── */}
      {metrics.pendingReviews > 0 && (
        <div
          className="glass-card flex flex-col gap-3 rounded-card p-3.5 sm:flex-row sm:items-center sm:justify-between sm:p-4"
          style={{
            backgroundImage: 'linear-gradient(100deg, var(--warn-bg), rgba(255,255,255,.30))',
            borderColor: 'var(--warn-bd)',
          }}
        >
          <div className="flex items-center gap-3">
            <span
              className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] text-white"
              style={{ background: 'linear-gradient(140deg,#f0a020,#e08b06)' }}
            >
              <Camera className="w-[18px] h-[18px]" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <h3 className="text-[12.5px] font-extrabold tracking-[-.015em] text-ink">
                Supervayzer diqqətinə: {metrics.pendingReviews} yeni rəf auditi təsdiq gözləyir
              </h3>
              <p className="mt-0.5 text-[11px] text-ink-2">
                Sahə heyətinin göndərdiyi fotoları planogramla yanaşı müqayisə edərək təsdiqləyin və
                ya rəy yazın.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigateTab('review')}
            className="btn-g flex-none self-start sm:self-auto"
          >
            Yoxlama Mərkəzinə keç
            <ArrowUpRight className="w-3.5 h-3.5" strokeWidth={2.2} />
          </button>
        </div>
      )}

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
                  <th>Planogram Tapşırığı</th>
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
                          {scenarioChip(sub)}
                          <p className="text-[12px] font-bold leading-tight tracking-[-.015em] text-ink">
                            {sub.task?.title || 'Rəf Auditi'}
                          </p>
                        </div>
                        <span className="mt-0.5 block text-[10px] capitalize text-muted">
                          {sub.task?.priority} prioritet
                        </span>
                      </td>

                      <td>
                        <b className="block text-[12px] font-bold tracking-[-.01em] text-ink">
                          {sub.store?.name || 'Mağaza'}
                        </b>
                        <span className="mt-0.5 block font-mono text-[10px] text-muted">
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
