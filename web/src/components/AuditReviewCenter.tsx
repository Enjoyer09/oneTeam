import React, { useState } from 'react';
import { ModalPortal } from './ui/ModalPortal';
import {
  CheckCircle2,
  XCircle,
  Search,
  Store as StoreIcon,
  Sparkles,
  Layers,
  X,
  Calendar,
  Eye,
  EyeOff,
  Zap,
  Bot,
  Camera,
  CheckSquare,
} from 'lucide-react';
import { Submission, SubmissionStatus } from '../types';
import { useModalA11y } from '../lib/useModalA11y';

interface AuditReviewCenterProps {
  submissions: Submission[];
  selectedSubmission: Submission | null;
  setSelectedSubmission: (sub: Submission | null) => void;
  /**
   * Hər üçü `Promise<boolean>` qaytarır: `true` = əməliyyat də edildi.
   * Komponent yalnız `true` olduqda modalı bağlayır — bəs qalan hər şey
   * (yazılmış səbəbi silmək, seçilmiş auditi bağlamaq) uğursuzluqda itirilmiş
   * hesab olunur. `false` gələndə `runAction` artıq istifadəçiyə toast göstərib,
   * ona görə komponent yalnız "heç nə etmə" deyir.
   */
  onApprove: (id: string) => Promise<boolean>;
  onAIApprove?: (id: string) => Promise<boolean>;
  onReject: (id: string, feedback: string) => Promise<boolean>;
  initialFilter?: SubmissionStatus | 'all';
}

export const AuditReviewCenter: React.FC<AuditReviewCenterProps> = ({
  submissions,
  selectedSubmission,
  setSelectedSubmission,
  onApprove,
  onAIApprove,
  onReject,
  initialFilter,
}) => {
  const [filterStatus, setFilterStatus] = useState<SubmissionStatus | 'all'>(
    initialFilter || 'all',
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [rejectFeedback, setRejectFeedback] = useState('');
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [showBoundingBoxes, setShowBoundingBoxes] = useState(true);
  const [activePhotoView, setActivePhotoView] = useState<'after' | 'before'>('after');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isReevaluating, setIsReevaluating] = useState(false);

  React.useEffect(() => {
    if (initialFilter) {
      setFilterStatus(initialFilter);
    }
  }, [initialFilter]);

  /* Escape bağlayır, fokus modalın içində qalır, bağlananda geri qaytar */
  const reviewModalRef = useModalA11y<HTMLDivElement>(!!selectedSubmission, () =>
    setSelectedSubmission(null),
  );

  // Open the reject drawer for low-scoring audits so the supervisor can note a
  // reason, but start the field from the real reviewer feedback (or empty) —
  // never from a canned rejection text.
  React.useEffect(() => {
    if (selectedSubmission) {
      setActivePhotoView('after');
      setIsReevaluating(false);
      setRejectError(null);
      const lowScore =
        selectedSubmission.ai_score !== null && (selectedSubmission.ai_score ?? 100) < 60;
      setShowRejectInput(lowScore);
      setRejectFeedback(selectedSubmission.reviewer_feedback || '');
    }
  }, [selectedSubmission]);

  const getScenarioBadge = (sub: Submission) => {
    const scenario = sub.metadata?.scenario;
    if (scenario === 'scenario_a_compliant') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-emerald-100 text-emerald-800 border border-emerald-300">
          ⭐ Ssenari A: İdeal (95%)
        </span>
      );
    }
    if (scenario === 'scenario_b_gap') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-amber-100 text-amber-800 border border-amber-300">
          ⚠️ Ssenari B: 2 Boşluq/Gap (70%)
        </span>
      );
    }
    if (scenario === 'scenario_c_missing_sprite') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-rose-100 text-rose-800 border border-rose-300">
          ❌ Ssenari C: Çatışmayan Sprite (55%)
        </span>
      );
    }
    return null;
  };

  // Filter submissions
  const filteredSubmissions = submissions.filter((sub) => {
    const matchesStatus = filterStatus === 'all' || sub.status === filterStatus;
    const query = searchQuery.toLowerCase();
    const matchesSearch =
      !query ||
      sub.task?.title.toLowerCase().includes(query) ||
      sub.store?.name.toLowerCase().includes(query) ||
      sub.store?.store_code.toLowerCase().includes(query);
    return matchesStatus && matchesSearch;
  });

  /**
   * Qərar handler-ləri YALNIZ uğurluqda modalı bağlayır.
   *
   * Əvvəl `try { await onApprove(id); setSelectedSubmission(null); } finally {…}`
   * idi və xəta halında da `setSelectedSubmission(null)` işləyirdi — server 500
   * qaytardıqda istifadəçi sorğunun uğurlu olduğunu görürdü. İmtina halında
   * `setRejectFeedback('')` yazılmış səbəbi də silirdi, belə də istifadəçi
   * təkrar yazmalı olurdu. `false` gələndə heç nə dəyişmir: səbəb yazılı qalır,
   * modal açıq qalır, `runAction` toast göstərib.
   */
  const handleApproveClick = async (id: string) => {
    setIsProcessing(true);
    try {
      const ok = await onApprove(id);
      if (ok) setSelectedSubmission(null);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAIApproveClick = async (id: string) => {
    setIsProcessing(true);
    try {
      const ok = onAIApprove ? await onAIApprove(id) : await onApprove(id);
      if (ok) setSelectedSubmission(null);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRejectSubmit = async (id: string) => {
    if (!rejectFeedback.trim()) {
      setRejectError('Zəhmət olmasa imtina səbəbini qeyd edin.');
      return;
    }
    setRejectError(null);
    setIsProcessing(true);
    try {
      const ok = await onReject(id, rejectFeedback.trim());
      // Yalnız uğurluqdan sonra: yazılmış səbəb uğursuzluqda qalır, ki bir dəfə
      // də yazmasın — imtina səbəbi uzun mətn olur və əl ilə təkrar yazılması
      // həddindən artıq cəhd deyil.
      if (ok) {
        setRejectFeedback('');
        setShowRejectInput(false);
        setSelectedSubmission(null);
      }
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Filters & Search Toolbar */}
      <div className="glass-card rounded-card p-4 flex flex-col md:flex-row items-center justify-between gap-4">
        {/* Status Filter Tabs */}
        <div className="flex items-center space-x-1.5 w-full md:w-auto overflow-x-auto pb-2 md:pb-0">
          {[
            { id: 'all', label: 'Bütün Fotolar' },
            { id: 'pending_review', label: '⏳ Gözləyən' },
            { id: 'approved', label: '✅ Təsdiqlənmiş' },
            { id: 'rejected', label: '❌ İmtina Edilmiş' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFilterStatus(tab.id as any)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap cursor-pointer ${
                filterStatus === tab.id
                  ? 'bg-[var(--g-pop)] text-ink shadow-g1 border border-hair'
                  : 'bg-[var(--g-panel)] text-ink-2 hover:bg-[var(--g-card)] border border-transparent'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search Input */}
        <div className="relative w-full md:w-72">
          <Search className="w-4 h-4 text-muted absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Mağaza və ya tapşırıq axtar..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-[var(--g-panel)] border border-hair rounded-lg text-xs text-ink placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45"
          />
        </div>
      </div>

      {/* Gallery Grid of Submitted Audits */}
      {filteredSubmissions.length === 0 ? (
        <div className="glass-card rounded-card p-12 text-center">
          <p className="text-sm font-semibold text-ink-2">Axtarışa uyğun rəf fotosu tapılmadı.</p>
          <p className="text-xs text-muted mt-1">Filtrləri təmizləyərək yenidən yoxlayın.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {filteredSubmissions.map((sub) => {
            const dateStr = new Date(sub.submitted_at).toLocaleDateString('az-AZ', {
              timeZone: 'Asia/Baku',
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            });

            return (
              <div
                key={sub.id}
                className="group glass-card rounded-card overflow-hidden hover:shadow-md transition-all flex flex-col"
              >
                {/* Image Container with Badges */}
                <div className="relative aspect-[4/3] bg-[var(--g-panel)] overflow-hidden">
                  <img
                    src={sub.photo_url}
                    alt={sub.task?.title || 'Shelf'}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                  <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 flex-wrap">
                    {sub.status === 'pending_review' && (
                      <span className="pill-photo p-warn">
                        <span className="dot" />
                        Gözləyir
                      </span>
                    )}
                    {sub.status === 'approved' && (
                      <span className="pill-photo p-ok">
                        <span className="dot" />
                        Təsdiqləndi
                      </span>
                    )}
                    {sub.status === 'rejected' && (
                      <span className="pill-photo p-bad">
                        <span className="dot" />
                        İmtina edildi
                      </span>
                    )}
                    {sub.ai_score !== undefined && sub.ai_score !== null && (
                      <span
                        className={`pill-photo ${
                          sub.ai_score >= 80 ? 'p-ok' : sub.ai_score >= 60 ? 'p-warn' : 'p-bad'
                        }`}
                      >
                        <span className="dot" />
                        AI {sub.ai_score}%
                      </span>
                    )}
                    {sub.before_photo_url && (
                      <span className="pill-photo p-info">
                        <Camera className="w-2.5 h-2.5" />
                        Əvvəl / Sonra
                      </span>
                    )}
                    {sub.location_mocked && (
                      <span
                        className="pill-photo p-bad"
                        title="Cihaz mövqeyi saxta/simulyasiya kimi işarələdi — təsdiq əl ilə override sayılır"
                      >
                        <span className="dot" />
                        🚩 Saxta GPS
                      </span>
                    )}
                    {/* Weaker evidence, NOT a fraud finding. Deliberately a
                        different pill: "Saxta GPS" says the device lied, this
                        says nobody captured a location at all (the bot's skip
                        button). Both block auto-approval, but a reviewer should
                        not read an honest merch who declined location sharing as
                        a cheater. */}
                    {sub.location_unverified && !sub.location_mocked && (
                      <span
                        className="pill-photo p-warn"
                        title="Lokasiya götürülmədi — audit zəif sübut kimi qeydə alınır"
                      >
                        <span className="dot" />
                        📍 Lokasiya yoxdur
                      </span>
                    )}
                  </div>
                </div>

                {/* Card Content */}
                <div className="p-4 flex-1 flex flex-col justify-between space-y-3">
                  <div>
                    {getScenarioBadge(sub) && <div className="mb-1.5">{getScenarioBadge(sub)}</div>}
                    <h4 className="font-bold text-xs text-ink line-clamp-1">
                      {sub.task?.title || 'Planogram Auditi'}
                    </h4>
                    <p className="text-[11px] text-ink-2 flex items-center gap-1 mt-1 font-medium">
                      <StoreIcon className="w-3.5 h-3.5 text-muted" />
                      {sub.store?.name || 'Mağaza'}
                    </p>
                    <p className="text-[11px] text-muted font-mono mt-0.5">
                      {sub.store?.store_code} • {dateStr}
                    </p>

                    {sub.reviewer_feedback && (
                      <div className="mt-2 p-2 rounded-lg bg-rose-50 border border-rose-100 text-[11px] text-rose-800">
                        <span className="font-bold">Supervayzer rəyi:</span> {sub.reviewer_feedback}
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => {
                      setSelectedSubmission(sub);
                      setShowRejectInput(false);
                      setRejectFeedback('');
                      setRejectError(null);
                    }}
                    className="w-full py-2 px-3 rounded-lg bg-[var(--g-panel)] hover:bg-[var(--coke-soft)] hover:text-coke text-ink font-bold text-xs transition-colors flex items-center justify-center space-x-1.5 cursor-pointer"
                  >
                    <Layers className="w-3.5 h-3.5" />
                    <span>Planogramla Müqayisə Et</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ====================================================================== */}
      {/* SIDE-BY-SIDE COMPARISON MODAL (CORE FEATURE) */}
      {/* ====================================================================== */}
      {selectedSubmission && (
        <ModalPortal>
          <div className="fixed inset-0 z-50 modal-veil flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
            <div
              ref={reviewModalRef}
              role="dialog"
              aria-modal="true"
              aria-label="Rəf auditi müqayisəsi"
              className="glass-pop w-full max-w-5xl rounded-card overflow-hidden my-auto flex flex-col max-h-[92vh]"
            >
              {/* Modal Header */}
              <div className="p-5 border-b border-hair flex items-center justify-between bg-[var(--g-panel)]">
                <div>
                  <div className="flex items-center space-x-2 flex-wrap gap-y-1">
                    {getScenarioBadge(selectedSubmission)}
                    <h3 className="font-extrabold text-sm sm:text-base text-ink">
                      {selectedSubmission.task?.title}
                    </h3>
                    <span className="chip-g uppercase tracking-wider">
                      {selectedSubmission.task?.priority}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted mt-1">
                    <span className="flex items-center gap-1 font-semibold text-ink">
                      <StoreIcon className="w-3.5 h-3.5 text-muted" />
                      {selectedSubmission.store?.name} ({selectedSubmission.store?.store_code})
                    </span>
                    <span className="flex items-center gap-1 text-[11px]">
                      <Calendar className="w-3.5 h-3.5 text-muted" />
                      {new Date(selectedSubmission.submitted_at).toLocaleString('az-AZ', {
                        timeZone: 'Asia/Baku',
                      })}
                    </span>
                  </div>
                </div>

                <button
                  onClick={() => setSelectedSubmission(null)}
                  className="w-8 h-8 rounded-full bg-[var(--g-panel)] hover:bg-[var(--g-card)] text-ink-2 flex items-center justify-center transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Spoofed-location hold: shown before anything else, because it
                  changes what "approve" means — a mock fix is held for review and
                  approving it is a deliberate override of the anti-fraud block. */}
              {selectedSubmission.location_mocked && (
                <div className="p-3.5 mx-5 mt-4 rounded-xl border border-rose-300 bg-rose-50/90 flex items-start gap-3">
                  <span className="text-lg leading-none mt-0.5">🚩</span>
                  <div>
                    <p className="font-extrabold text-xs text-rose-800">
                      Saxta / simulyasiya edilmiş GPS mövqeyi
                    </p>
                    <p className="text-[11px] text-rose-700 mt-0.5 leading-relaxed">
                      Cihaz bu mövqeyi mock kimi işarələdi. Audit avtomatik təsdiqlənmir və yoxlama
                      üçün saxlanılır — təsdiqləsəniz, bu, anti-fraud bloku üzərində şüurlu override
                      kimi qeydə alınır.
                    </p>
                  </div>
                </div>
              )}

              {/* No location at all. Amber, not rose, and the copy says why:
                  this is not an accusation. The Telegram bot offers a skip
                  button, and an honest merchandiser indoors with GPS off takes
                  it. Reading that as fraud would push people back to WhatsApp,
                  where there is no record at all — so the gap is shown as
                  weaker evidence and a judgement call, which is what it is. */}
              {selectedSubmission.location_unverified && !selectedSubmission.location_mocked && (
                <div className="p-3.5 mx-5 mt-4 rounded-xl border border-amber-300 bg-amber-50/90 flex items-start gap-3">
                  <span className="text-lg leading-none mt-0.5">📍</span>
                  <div>
                    <p className="font-extrabold text-xs text-amber-800">Lokasiya götürülmədi</p>
                    <p className="text-[11px] text-amber-700 mt-0.5 leading-relaxed">
                      Bu audit Telegram kanalından gəlib və işçi lokasiyanı paylaşmayıb (düymə
                      "lokasiya olmadan davam et" idi) — mağaza içindəki GPS işləməyə bilər. API
                      mağazanın öz koordinatını istifadə etdiyi üçün coğrafiya yoxlaması keçdi,
                      lakin bu heç nə sübut etmir. Audit avtomatik təsdiqlənmir; təsdiqləsəniz,
                      qeydə "lokasiyasız sübut" kimi düşür.
                    </p>
                  </div>
                </div>
              )}

              {/* AI Vision Compliance Summary Banner */}
              {selectedSubmission.ai_score !== undefined &&
                selectedSubmission.ai_score !== null && (
                  <div
                    className={`p-4 mx-5 mt-4 rounded-xl border flex flex-col md:flex-row items-start md:items-center justify-between gap-4 ${
                      (selectedSubmission.ai_score ?? 0) >= 80
                        ? 'bg-emerald-50/80 border-emerald-200'
                        : (selectedSubmission.ai_score ?? 0) >= 60
                          ? 'bg-amber-50/80 border-amber-200'
                          : 'bg-rose-50/80 border-rose-200'
                    }`}
                  >
                    <div className="flex items-center space-x-3.5">
                      <div
                        className={`w-14 h-14 rounded-xl flex flex-col items-center justify-center font-extrabold text-white shadow-sm flex-shrink-0 ${
                          (selectedSubmission.ai_score ?? 0) >= 80
                            ? 'bg-emerald-600'
                            : (selectedSubmission.ai_score ?? 0) >= 60
                              ? 'bg-amber-500'
                              : 'bg-rose-600'
                        }`}
                      >
                        <span className="text-base leading-none">
                          {selectedSubmission.ai_score}%
                        </span>
                        <span className="text-[10px] uppercase tracking-wider opacity-90">
                          AI BAL
                        </span>
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-extrabold text-xs sm:text-sm text-ink flex items-center gap-1.5">
                            <Bot className="w-4 h-4 text-coke-500" />
                            Süni İntellekt (AI) Planogram Təhlili
                          </h4>
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full font-extrabold uppercase ${
                              (selectedSubmission.ai_score ?? 0) >= 80
                                ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                                : 'bg-amber-100 text-amber-800 border border-amber-300'
                            }`}
                          >
                            {(selectedSubmission.ai_score ?? 0) >= 80
                              ? 'Avto-Təsdiqə Uyğun'
                              : 'Əl ilə Yoxlama Tələb Olunur'}
                          </span>
                        </div>
                        <p className="text-xs text-ink-2 mt-1 leading-relaxed">
                          {selectedSubmission.ai_summary ||
                            'Rəf auditi üzrə süni intellekt təhlili aparılıb.'}
                        </p>
                      </div>
                    </div>

                    {selectedSubmission.ai_score &&
                      selectedSubmission.ai_score >= 80 &&
                      selectedSubmission.status === 'pending_review' && (
                        <button
                          disabled={isProcessing}
                          onClick={() => void handleAIApproveClick(selectedSubmission.id)}
                          className="w-full md:w-auto px-4 py-2.5 rounded-xl btn-coke text-white font-extrabold text-xs shadow-md shadow-coke-500/20 flex items-center justify-center space-x-1.5 transition-all cursor-pointer whitespace-nowrap"
                        >
                          <Zap className="w-4 h-4 fill-white" />
                          <span>Bir Kliklə AI Təsdiqi ({selectedSubmission.ai_score}%)</span>
                        </button>
                      )}
                  </div>
                )}

              {/* Modal Body: Side-by-Side View */}
              <div className="p-5 overflow-y-auto flex-1 grid grid-cols-1 md:grid-cols-2 gap-5 bg-[var(--g-panel)]">
                {/* Left Column: Reference Planogram Photo */}
                <div className="bg-[var(--g-card)] p-4 rounded-xl border border-hair flex flex-col">
                  <div className="flex items-center justify-between pb-2.5 mb-2.5 border-b border-hair-2">
                    <div className="flex items-center space-x-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
                      <h4 className="font-bold text-xs uppercase tracking-wider text-ink-2">
                        Standart Planogram (İdeal Rəf Düzülüşü)
                      </h4>
                    </div>
                    <span className="text-[10px] font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded">
                      Referans Nümunə
                    </span>
                  </div>

                  <div className="flex-1 aspect-[4/3] rounded-lg overflow-hidden bg-[var(--g-panel)] border border-hair relative">
                    <img
                      src={selectedSubmission.task?.reference_image_url || '/logo.jpg'}
                      alt="Planogram Reference"
                      className="w-full h-full object-cover"
                    />
                  </div>

                  <div className="mt-3 p-2.5 bg-[var(--g-panel)] rounded-lg border border-hair-2 text-xs text-ink-2">
                    <p className="font-bold text-ink mb-0.5 text-[11px]">Rəf Təlimatı:</p>
                    <p className="line-clamp-3 text-[11px] leading-relaxed">
                      {selectedSubmission.task?.description}
                    </p>
                  </div>
                </div>

                {/* Right Column: Submitted Shelf Photo with AI Bounding Box Overlay */}
                <div className="bg-[var(--g-card)] p-4 rounded-xl border border-hair flex flex-col">
                  <div className="flex items-center justify-between pb-2.5 mb-2.5 border-b border-hair-2">
                    <div className="flex items-center space-x-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-coke-500"></span>
                      <h4 className="font-bold text-xs uppercase tracking-wider text-ink-2">
                        Mağazadan Yüklənən Rəf Fotosu
                      </h4>
                    </div>

                    <div className="flex items-center gap-2">
                      {/* Before & After Photo View Toggle */}
                      {selectedSubmission.before_photo_url && (
                        <div className="flex items-center gap-1 bg-[var(--g-panel)] p-0.5 rounded-lg border border-hair">
                          <button
                            onClick={() => setActivePhotoView('before')}
                            className={`px-2 py-1 rounded text-[11px] font-extrabold transition-all cursor-pointer ${
                              activePhotoView === 'before'
                                ? 'bg-slate-900 text-white'
                                : 'text-ink-2 hover:text-ink'
                            }`}
                          >
                            📷 Before
                          </button>
                          <button
                            onClick={() => setActivePhotoView('after')}
                            className={`px-2 py-1 rounded text-[11px] font-extrabold transition-all cursor-pointer ${
                              activePhotoView === 'after'
                                ? 'bg-coke-600 text-white'
                                : 'text-ink-2 hover:text-ink'
                            }`}
                          >
                            ✨ After
                          </button>
                        </div>
                      )}

                      {/* Bounding Boxes Toggle Button (active only on After view) */}
                      {activePhotoView === 'after' &&
                        selectedSubmission.ai_detections &&
                        selectedSubmission.ai_detections.length > 0 && (
                          <button
                            onClick={() => setShowBoundingBoxes(!showBoundingBoxes)}
                            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold flex items-center space-x-1.5 transition-all cursor-pointer ${
                              showBoundingBoxes
                                ? 'bg-coke-50 text-coke-600 border border-coke-200'
                                : 'bg-[var(--g-panel)] text-muted hover:bg-[var(--g-card)]'
                            }`}
                          >
                            {showBoundingBoxes ? (
                              <Eye className="w-3.5 h-3.5 text-coke-500" />
                            ) : (
                              <EyeOff className="w-3.5 h-3.5" />
                            )}
                            <span>
                              {showBoundingBoxes ? 'AI Qutuları: AÇIQ' : 'AI Qutuları: BAĞLI'}
                            </span>
                          </button>
                        )}
                    </div>
                  </div>

                  <div className="flex-1 aspect-[4/3] rounded-lg overflow-hidden bg-slate-900 border border-hair relative select-none">
                    <img
                      src={
                        activePhotoView === 'before' && selectedSubmission.before_photo_url
                          ? selectedSubmission.before_photo_url
                          : selectedSubmission.photo_url
                      }
                      alt="Store Shelf Upload"
                      className="w-full h-full object-cover"
                    />

                    {/* Before / After Status Watermark */}
                    {selectedSubmission.before_photo_url && (
                      <div className="absolute top-2.5 left-2.5 px-2.5 py-1 rounded-md text-[10px] font-extrabold bg-slate-950/80 backdrop-blur-sm text-white border border-white/20">
                        {activePhotoView === 'before'
                          ? '📷 İLKİN RƏF (DÜZƏLİŞDƏN ƏVVƏL)'
                          : '✨ YENİLƏNMİŞ RƏF (DÜZƏLİŞDƏN SONRA)'}
                      </div>
                    )}

                    {/* Visual Bounding Boxes Overlay (only in After view) */}
                    {activePhotoView === 'after' &&
                      showBoundingBoxes &&
                      selectedSubmission.ai_detections?.map((det) => (
                        <div
                          key={det.id}
                          style={{
                            left: `${det.box.x}%`,
                            top: `${det.box.y}%`,
                            width: `${det.box.width}%`,
                            height: `${det.box.height}%`,
                            borderColor: det.color,
                            borderStyle: det.sku === 'out_of_stock_gap' ? 'dashed' : 'solid',
                          }}
                          className={`absolute border-2 rounded transition-transform duration-100 pointer-events-auto hover:scale-[1.02] hover:z-30 hover:border-[3px] ${
                            det.sku === 'out_of_stock_gap' ? 'bg-rose-500/20' : 'bg-black/10'
                          }`}
                          title={`${det.label} (${Math.round(det.confidence * 100)}% etibarlılıq)`}
                        >
                          <div
                            style={{ backgroundColor: det.color }}
                            className="text-[9px] font-extrabold text-white px-1.5 py-0.5 rounded-br max-w-full truncate shadow-sm flex items-center gap-1"
                          >
                            {det.sku === 'out_of_stock_gap' ? '⚠️ BOŞLUQ' : det.label.split(' ')[0]}
                            <span className="opacity-80 text-[8px]">
                              {Math.round(det.confidence * 100)}%
                            </span>
                          </div>
                        </div>
                      ))}
                  </div>

                  {/* Detected Products Color Legend */}
                  {selectedSubmission.ai_detections &&
                    selectedSubmission.ai_detections.length > 0 && (
                      <div className="mt-2.5 pt-2 border-t border-hair-2 flex items-center justify-between flex-wrap gap-2 text-[11px] text-ink-2">
                        <span className="font-bold text-ink-2">Aşkarlanan SKU-lar:</span>
                        <div className="flex items-center gap-2.5 flex-wrap">
                          <span className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-[#F40009]"></span> Classic
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-[#111827]"></span> Zero Sugar
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-[#FF7300]"></span> Fanta
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-[#008B47]"></span> Sprite
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full border border-dashed border-[#EF4444] bg-rose-100"></span>{' '}
                            Boşluq
                          </span>
                        </div>
                      </div>
                    )}

                  <div className="mt-2.5 p-2.5 bg-[var(--g-panel)] rounded-lg border border-hair-2 text-[11px] text-ink-2 flex items-center justify-between">
                    <div>
                      <span className="font-bold text-ink">Göndərən:</span>{' '}
                      {selectedSubmission.submitter_name || 'Sahə Merchandiser-i'}
                    </div>
                    <div className="font-mono text-muted text-[11px]">
                      Telegram ID: {selectedSubmission.metadata?.telegram_user_id || 'N/A'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Field Audit Checklist Answers Section */}
              {selectedSubmission.checklist_answers &&
                selectedSubmission.checklist_answers.length > 0 && (
                  <div className="mx-5 my-2 p-3.5 bg-blue-50/80 rounded-xl border border-blue-200">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-extrabold text-blue-900 flex items-center gap-1.5">
                        <CheckSquare className="w-4 h-4 text-blue-600" />
                        Sahə Auditi Çeklist Cavabları ({
                          selectedSubmission.checklist_answers.length
                        }{' '}
                        sual təsdiqlənib)
                      </span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-800">
                        FMCG Validation Pass
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      {selectedSubmission.checklist_answers.map((ans, idx) => (
                        <div
                          key={idx}
                          className="p-2.5 bg-[var(--g-card)] rounded-lg border border-blue-100"
                        >
                          <span className="block text-[11px] text-muted font-medium truncate mb-1">
                            {ans.question || ans.questionId}
                          </span>
                          <span className="text-xs font-extrabold text-ink flex items-center gap-1">
                            {typeof ans.value === 'boolean' ? (
                              ans.value ? (
                                <span className="text-emerald-700 font-bold">
                                  ✅ Bəli (Təsdiqləndi)
                                </span>
                              ) : (
                                <span className="text-rose-700 font-bold">❌ Xeyr (Çatışmır)</span>
                              )
                            ) : (
                              <span className="text-ink">
                                {ans.value}
                                {ans.unit ? ` ${ans.unit}` : ''}{' '}
                                <span className="text-emerald-600 text-[11px] font-bold">
                                  ✅ Normada
                                </span>
                              </span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              {/* Reject Feedback Textarea Drawer */}
              {showRejectInput && (
                <div className="px-5 py-3 bg-rose-50 border-t border-rose-200 space-y-2">
                  <label className="block text-xs font-bold text-rose-900">
                    İmtina Səbəbini və Tələb Olunan Düzəlişi Qeyd Edin:
                  </label>
                  <textarea
                    rows={2}
                    placeholder="Məsələn: Coca-Cola Classic 0.5L alt sırada 2 facing çatışmır və etiketlər düz çevrilməyib..."
                    value={rejectFeedback}
                    onChange={(e) => {
                      setRejectFeedback(e.target.value);
                      if (rejectError) setRejectError(null);
                    }}
                    aria-invalid={rejectError ? true : undefined}
                    className={`w-full p-2.5 text-xs rounded-lg border focus:outline-none focus:ring-2 focus:ring-rose-500 bg-[var(--g-card)] ${
                      rejectError ? 'border-rose-500' : 'border-rose-300'
                    }`}
                  />
                  {rejectError && (
                    <p className="text-[11px] font-bold text-rose-700">{rejectError}</p>
                  )}
                </div>
              )}

              {/* Modal Actions Footer */}
              <div className="p-4 bg-[var(--g-card)] border-t border-hair flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="flex items-center space-x-1.5 text-xs text-muted">
                  <Sparkles className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                  <span className="text-[11px]">
                    Supervayzer qərarı mağazanın audit statusunu dərhal yeniləyəcək.
                  </span>
                </div>

                <div className="flex items-center space-x-2.5 w-full sm:w-auto">
                  {selectedSubmission.status !== 'pending_review' && !isReevaluating ? (
                    <div className="flex items-center gap-2.5 flex-wrap">
                      {selectedSubmission.status === 'approved' ? (
                        <span className="px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-300 text-xs font-extrabold flex items-center gap-1.5 shadow-sm">
                          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                          Təsdiqlənib (Yekunlaşıb)
                        </span>
                      ) : (
                        <span className="px-3 py-1.5 rounded-lg bg-rose-50 text-rose-800 border border-rose-300 text-xs font-extrabold flex items-center gap-1.5 shadow-sm">
                          <XCircle className="w-4 h-4 text-rose-600" />
                          İmtina Edilib
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setIsReevaluating(true)}
                        className="btn-g text-xs font-bold"
                        title="Qərarı dəyişmək və ya yenidən yoxlamaq"
                      >
                        Qərarı Yenilə...
                      </button>
                    </div>
                  ) : !showRejectInput ? (
                    <>
                      {isReevaluating && (
                        <button
                          type="button"
                          onClick={() => setIsReevaluating(false)}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold text-ink-2 hover:bg-[var(--g-panel)] border border-hair"
                        >
                          Ləğv Et
                        </button>
                      )}
                      <button
                        disabled={isProcessing}
                        onClick={() => setShowRejectInput(true)}
                        className="flex-1 sm:flex-none flex items-center justify-center space-x-1.5 px-4 py-2 rounded-lg border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold text-xs transition-colors cursor-pointer"
                      >
                        <XCircle className="w-4 h-4" />
                        <span>❌ İmtina Et</span>
                      </button>

                      {selectedSubmission.ai_score && selectedSubmission.ai_score >= 80 && (
                        <button
                          disabled={isProcessing}
                          onClick={() => void handleAIApproveClick(selectedSubmission.id)}
                          className="flex-1 sm:flex-none flex items-center justify-center space-x-1.5 px-4 py-2 rounded-lg btn-coke text-white font-bold text-xs transition-all cursor-pointer"
                        >
                          <Zap className="w-4 h-4 fill-white" />
                          <span>⚡ AI Təsdiqi</span>
                        </button>
                      )}

                      <button
                        disabled={isProcessing}
                        onClick={() => void handleApproveClick(selectedSubmission.id)}
                        className="flex-1 sm:flex-none flex items-center justify-center space-x-1.5 px-5 py-2 rounded-lg btn-ok text-white font-bold text-xs transition-all cursor-pointer"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        <span>✅ Təsdiq Et</span>
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => setShowRejectInput(false)}
                        className="px-3.5 py-2 rounded-lg bg-[var(--g-panel)] text-ink-2 text-xs font-bold hover:bg-[var(--g-card)] cursor-pointer"
                      >
                        Ləğv Et
                      </button>
                      <button
                        disabled={isProcessing}
                        onClick={() => void handleRejectSubmit(selectedSubmission.id)}
                        className="px-5 py-2 rounded-lg btn-danger text-white text-xs font-bold transition-all cursor-pointer"
                      >
                        İmtina Qərarını Göndər
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </div>
  );
};
