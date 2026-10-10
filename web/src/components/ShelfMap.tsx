import React, { useState } from 'react';
import { LayoutGrid, Search, X, Inbox, Plus, Pencil, Trash2, AlertTriangle } from 'lucide-react';
import { Product, ShelfPosition, ShelfMetrics } from '../types';
import { ModalPortal } from './ui/ModalPortal';
import { useModalA11y } from '../lib/useModalA11y';

interface ShelfMapProps {
  shelfPositions: ShelfPosition[];
  /**
   * OSA / share of shelf (dalğa 1.4) — serverin saydığı rəqəm.
   * NULL deyil: sayım aparılmazsa şerid gizlənir, yox saxta sıfır göstərilir.
   */
  metrics: ShelfMetrics | null;
  /** Məhsul seçimi üçün kataloq — boş xəritədə də dolu ola bilər. */
  products: Product[];
  /** Yeni mövqe yaradır. Uğursuzluqda mesajı forma göstərir. */
  onCreate: (data: ShelfFormValues) => Promise<unknown>;
  onUpdate: (id: string, changes: Partial<ShelfPosition>) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  /**
   * Əl sayımı göndərir (0–999). canEdit-dən ASILI DEYİL: saymaq işçinin öz
   * işidir, redaktə isə admin/supervayzer qapısındadır — API də belə ayırır.
   */
  onCount: (id: string, units: number) => Promise<unknown>;
  /** Merchandiser üçün false — API onsuz da rədd edir. */
  canEdit: boolean;
}

/**
 * Formanın öz forması, panelin snake_case sahələri ilə.
 *
 * level/position string kimi saxlanılır: `<input type="number">` React-də
 * həmişə string value göndərir, və boş xana ilə `0` arasındakı fərq yalnız
 * string-də aydın seçilir. Parse təsdiq zamanı — tam ədəd, >= 1.
 * `product_id` boş string = boş mövqe (məhsul təyin olunmayıb).
 */
export interface ShelfFormValues {
  section: string;
  level: string;
  position: string;
  product_id: string;
}

const EMPTY_FORM: ShelfFormValues = { section: '', level: '1', position: '1', product_id: '' };

function toFormValues(slot: ShelfPosition): ShelfFormValues {
  return {
    section: slot.section,
    level: String(slot.level),
    position: String(slot.position),
    product_id: slot.product_id ?? '',
  };
}

/** Kataloqdan məhsul tapır — tapılmasa (silinmiş SKU) boş qalır. */
function productName(products: Product[], id: string | null): string | null {
  if (!id) return null;
  return products.find((p) => p.id === id)?.name ?? null;
}

export const ShelfMap: React.FC<ShelfMapProps> = ({
  shelfPositions,
  metrics,
  products,
  onCreate,
  onUpdate,
  onDelete,
  onCount,
  canEdit,
}) => {
  const [searchTerm, setSearchTerm] = useState('');

  /** null = bağlı; 'new' və ya redaktə olunan mövqe. */
  const [editing, setEditing] = useState<ShelfPosition | 'new' | null>(null);
  const [form, setForm] = useState<ShelfFormValues>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<ShelfPosition | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  /** Sətiraltı sayım xətası — cədvəlin üstündə role=alert kimi görünür. */
  const [countError, setCountError] = useState<string | null>(null);

  const modalRef = useModalA11y<HTMLDivElement>(editing !== null, () => closeForm());
  const confirmRef = useModalA11y<HTMLDivElement>(pendingDelete !== null, () => closeConfirm());

  const query = searchTerm.trim().toLowerCase();

  // Bölmə → səviyyə → mövqe: xəritə oxunuşu həmişə bu silsilədədir.
  const sorted = [...shelfPositions].sort(
    (a, b) =>
      a.section.localeCompare(b.section, 'az') || a.level - b.level || a.position - b.position,
  );

  const filtered = sorted.filter((slot) => {
    if (!query) return true;
    if (slot.section.toLowerCase().includes(query)) return true;
    const assigned = productName(products, slot.product_id);
    if (assigned?.toLowerCase().includes(query)) return true;
    return String(slot.level) === query || String(slot.position) === query;
  });

  /** product_id -> (bölmə payı, sayılan ədəd) — sətirdə badge kimi göstərilir. */
  const shareByProduct = new Map<string, { share: number; units: number }>();
  for (const sectionMetric of metrics?.sections ?? []) {
    for (const entry of sectionMetric.products) {
      shareByProduct.set(entry.product_id, { share: entry.share, units: entry.units });
    }
  }

  /**
   * Sətirin sayım xanasından oxuyub göndərir (Enter və ya blur).
   *
   * Boş xana = dəyişiklik yoxdur (uncontrolled input server dəyəri ilə
   * qayıdır); sayımı sıfırlamaq API-də ayrıca əməliyyat deyil — `ponytail:`
   * lazım olanda units-i null-a qaytaran DELETE /count əlavə olunacaq.
   */
  const handleCount = async (slot: ShelfPosition, raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') return;
    const units = Number(trimmed);
    if (!Number.isInteger(units) || units < 0 || units > 999) {
      setCountError(`Sayım 0–999 arasında tam ədəd olmalıdır — ${slotLabel(slot)}.`);
      return;
    }
    if (slot.units === units) return; // dəyişiklik yox
    setCountError(null);
    try {
      await onCount(slot.id, units);
    } catch (error) {
      setCountError(error instanceof Error ? error.message : String(error));
    }
  };

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setEditing('new');
  }

  function openEdit(slot: ShelfPosition) {
    setForm(toFormValues(slot));
    setFormError(null);
    setEditing(slot);
  }

  function closeForm() {
    setEditing(null);
    setFormError(null);
    setSaving(false);
  }

  function closeConfirm() {
    setPendingDelete(null);
    setDeleteError(null);
    setDeleting(false);
  }

  const set = <K extends keyof ShelfFormValues>(key: K, value: ShelfFormValues[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError(null);

    // Ön yoxlama API-ninkini təkrarlayır (güvən sərhədi serverdədir), sadəcə
    // istifadəçi yazarkən dərhal görsün deyə: boş xana və ya 0 burada qalır.
    const level = Number(form.level);
    const position = Number(form.position);
    if (
      !Number.isInteger(level) ||
      level < 1 ||
      !Number.isInteger(position) ||
      position < 1 ||
      form.section.trim() === ''
    ) {
      setFormError('Bölmə boş olmamalı; səviyyə və mövqe 1 və ya daha böyük tam ədəd olmalıdır.');
      setSaving(false);
      return;
    }

    try {
      if (editing === 'new') {
        await onCreate(form);
      } else if (editing) {
        await onUpdate(editing.id, {
          section: form.section.trim(),
          level,
          position,
          product_id: form.product_id || null,
        });
      }
      closeForm();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmDelete() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(pendingDelete.id);
      closeConfirm();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  }

  const inputClass =
    'w-full px-3 py-2 border border-hair rounded-lg text-xs text-ink bg-[var(--g-card)] ' +
    'focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45';
  const labelClass = 'block text-xs font-bold text-ink-2 mb-1';

  const slotLabel = (slot: ShelfPosition) =>
    `${slot.section} · ${slot.level}. səviyyə / ${slot.position}. mövqe`;

  return (
    <div className="stagger-g flex flex-col gap-4 sm:gap-5">
      {/* ── Başlıq + axtarış ──────────────────────────────────────────────── */}
      <div className="glass-card flex flex-col gap-3.5 rounded-card p-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-extrabold tracking-[-.02em] text-ink">Rəf Xəritəsi</h3>
          <p className="mt-0.5 text-[11px] text-muted">
            Bölmə / səviyyə / mövqe — planogram müqayisəsinin bazası, mövqeyə təyin olunmuş SKU ilə
          </p>
        </div>

        <div className="flex w-full items-center gap-2.5 md:w-auto md:flex-none">
          <div className="relative min-w-0 flex-1 md:w-[260px]">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
              strokeWidth={2}
            />
            <input
              type="search"
              aria-label="Rəf xəritəsində axtarış"
              placeholder="Bölmə, məhsul, səviyyə..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-[38px] w-full rounded-[11px] border border-hair bg-[var(--g-panel)]
                         pl-9 pr-9 text-[12px] text-ink placeholder:text-muted
                         transition-colors duration-150
                         focus:border-coke/45 focus:bg-[var(--g-card)] focus:outline-none
                         focus-visible:outline-none focus:ring-2 focus:ring-[var(--coke-ring)]"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm('')}
                aria-label="Axtarışı təmizlə"
                className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center
                           rounded-md text-muted transition-colors hover:bg-[var(--g-card)] hover:text-ink"
              >
                <X className="h-3.5 w-3.5" strokeWidth={2.2} />
              </button>
            )}
          </div>

          {canEdit && (
            <button
              type="button"
              onClick={openCreate}
              className="flex h-[38px] flex-none items-center gap-1.5 rounded-[11px] bg-coke px-3.5
                         text-[12px] font-extrabold text-white transition-opacity hover:opacity-90
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--coke-ring)]"
            >
              <Plus className="h-4 w-4" strokeWidth={2.4} />
              <span>Yeni mövqe</span>
            </button>
          )}
        </div>
      </div>

      {/* ── OSA / share of shelf şeridi (dalğa 1.4) ────────────────────────── */}
      {metrics && (
        <div className="glass-card flex flex-wrap items-stretch gap-3 rounded-card p-4">
          <MetricTile
            label="OSA"
            value={metrics.osa === null ? '—' : `${metrics.osa} %`}
            hint={
              metrics.osa === null
                ? 'hələ sayım yoxdur'
                : `sayılan ${metrics.counted_slots} slot üzərindən — sayılmayan sayılır sayılmır`
            }
          />
          <MetricTile
            label="Sayılan"
            value={`${metrics.counted_slots} / ${metrics.assigned_slots}`}
            hint="sayılmış / təyin olunmuş slot"
          />
          <MetricTile
            label="Mövcud"
            value={String(metrics.present_slots)}
            hint="units > 0 olan slotlar"
          />
          <MetricTile
            label="Cəmi ədəd"
            value={String(metrics.total_units)}
            hint="bölmələr üzrə paylanır"
          />
        </div>
      )}

      {countError && (
        <p
          role="alert"
          className="rounded-lg border px-3 py-2 text-[11.5px] font-bold"
          style={{
            borderColor: 'var(--bad-dot)',
            color: 'var(--bad)',
            backgroundColor: 'var(--g-panel)',
          }}
        >
          {countError}
        </p>
      )}

      {/* ── Cədvəl ────────────────────────────────────────────────────────── */}
      <div className="glass-card overflow-hidden rounded-card">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2.5 px-6 py-14 text-center">
            <span
              className="grid h-12 w-12 place-items-center rounded-[14px]"
              style={{ backgroundColor: 'var(--g-panel)', color: 'var(--faint)' }}
            >
              <Inbox className="h-6 w-6" strokeWidth={1.7} />
            </span>
            <h4 className="text-[13px] font-extrabold text-ink">
              {query ? 'Uyğun mövqe tapılmadı' : 'Hələ rəf xəritəsi qurulmayıb'}
            </h4>
            <p className="max-w-[40ch] text-[11.5px] text-muted">
              {query
                ? 'Bölmə adını qısaltmağı və ya səviyyə/mövqe ədədi ilə axtarmağı sınayın.'
                : 'Yuxarıdaki "Yeni mövqe" düyməsi ilə ilk bölmə / səviyyə / mövqeyi əlavə edin.'}
            </p>
            {query ? (
              <button type="button" onClick={() => setSearchTerm('')} className="btn-g mt-1">
                Axtarışı təmizlə
              </button>
            ) : (
              canEdit && (
                <button type="button" onClick={openCreate} className="btn-g mt-1">
                  <Plus className="h-3.5 w-3.5" strokeWidth={2.4} />
                  Yeni mövqe
                </button>
              )
            )}
          </div>
        ) : (
          <div className="reflow-scroll overflow-x-auto px-2 pb-2.5 sm:px-3">
            <table className="tbl-g reflow lg:min-w-[880px]">
              <thead>
                <tr>
                  <th>Bölmə</th>
                  <th>Səviyyə</th>
                  <th>Mövqe</th>
                  <th>Təyin olunmuş məhsul</th>
                  <th>Sayım (ədəd)</th>
                  <th>Yaradılma</th>
                  {canEdit && <th className="text-right">Əməliyyat</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((slot) => {
                  const assigned = productName(products, slot.product_id);
                  return (
                    <tr key={slot.id}>
                      <td>
                        <div className="flex items-center gap-2">
                          <LayoutGrid className="h-4 w-4 flex-none text-coke" strokeWidth={1.9} />
                          <span className="text-[12px] font-bold tracking-[-.01em] text-ink">
                            {slot.section}
                          </span>
                        </div>
                      </td>

                      <td>
                        <span className="chip-g">{slot.level}</span>
                      </td>
                      <td>
                        <span className="chip-g">{slot.position}</span>
                      </td>

                      <td className="text-[11.5px] text-ink-2">
                        {assigned ? assigned : <span className="text-muted italic">boş mövqe</span>}
                      </td>

                      <td>
                        {slot.product_id ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="number"
                              min={0}
                              max={999}
                              step={1}
                              inputMode="numeric"
                              /* key sayım dəyişəndə xananı server dəyəri ilə yenidən
                                 yaradır — uncontrolled input belə sinxronlanır. */
                              key={`${slot.id}-${slot.units ?? 'none'}`}
                              defaultValue={slot.units ?? ''}
                              placeholder="—"
                              aria-label={`${slotLabel(slot)} — sayım`}
                              title={
                                slot.counted_at
                                  ? `Sayılıb: ${slot.counted_at.slice(0, 16).replace('T', ' ')}`
                                  : 'Hələ sayılmayıb — Enter və ya kənara basanda göndərilir'
                              }
                              onBlur={(e) => void handleCount(slot, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  void handleCount(slot, e.currentTarget.value);
                                }
                              }}
                              className="w-[62px] rounded-lg border border-hair bg-[var(--g-card)]
                                         px-2 py-1 text-[11.5px] font-mono text-ink
                                         focus:border-coke/45 focus:outline-none
                                         focus:ring-2 focus:ring-[var(--coke-ring)]"
                            />
                            {(() => {
                              const share = shareByProduct.get(slot.product_id);
                              if (!share || slot.units === null) return null;
                              return (
                                <span className="chip-g" title={`${share.units} ədəd — bölmə payı`}>
                                  %{share.share}
                                </span>
                              );
                            })()}
                          </div>
                        ) : (
                          <span className="text-muted italic" title="Boş mövqeyə sayım yoxdur">
                            —
                          </span>
                        )}
                      </td>

                      <td className="text-[11.5px] text-muted">
                        {slot.created_at ? slot.created_at.slice(0, 10) : '—'}
                      </td>

                      {canEdit && (
                        <td className="text-right">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => openEdit(slot)}
                              aria-label={`${slotLabel(slot)} — redaktə et`}
                              className="grid h-7 w-7 place-items-center rounded-md text-ink-2
                                         transition-colors hover:bg-[var(--g-panel)] hover:text-ink"
                            >
                              <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDeleteError(null);
                                setPendingDelete(slot);
                              }}
                              aria-label={`${slotLabel(slot)} — sil`}
                              className="grid h-7 w-7 place-items-center rounded-md text-ink-2
                                         transition-colors hover:bg-[var(--g-panel)] hover:text-[var(--bad)]"
                            >
                              <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {filtered.length > 0 && (
        <p className="px-1 text-[11px] text-muted">
          {query
            ? `${filtered.length} / ${shelfPositions.length} mövqe göstərilir`
            : `${shelfPositions.length} mövqe`}
        </p>
      )}

      {/* ==================================================================== */}
      {/* YARAT / REDAKTƏ ET MODALI                                             */}
      {/* ==================================================================== */}
      {editing !== null && (
        <ModalPortal>
          <div className="modal-veil fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4 sm:p-6">
            <div
              ref={modalRef}
              role="dialog"
              aria-modal="true"
              aria-label={editing === 'new' ? 'Yeni rəf mövqesi yarat' : 'Rəf mövqesini redaktə et'}
              className="glass-pop my-auto w-full max-w-lg overflow-hidden rounded-card"
            >
              <div className="flex items-center justify-between border-b border-hair bg-[var(--g-panel)] p-5">
                <div>
                  <h3 className="text-sm font-extrabold text-ink sm:text-base">
                    {editing === 'new' ? 'Yeni Rəf Mövqesi' : 'Rəf Mövqesini Redaktə Et'}
                  </h3>
                  <p className="text-xs text-muted">
                    Bölmə, səviyyə və mövqe — eyni koordinat ikinci dəfə dolu sayılmır
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeForm}
                  aria-label="Bağla"
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--g-panel)] text-ink-2 transition-colors hover:bg-[var(--g-card)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <form onSubmit={(event) => void handleSubmit(event)} className="space-y-3.5 p-5">
                <div>
                  <label htmlFor="shelf-section" className={labelClass}>
                    Bölmə *
                  </label>
                  <input
                    id="shelf-section"
                    type="text"
                    required
                    placeholder="Kola rəfi"
                    value={form.section}
                    onChange={(e) => set('section', e.target.value)}
                    className={inputClass}
                  />
                  <p className="mt-1 text-[11px] text-muted">
                    Fiziki bölmənin adı (məsələn "Kola rəfi", "Vitrin A"). Bu addan eyni səviyyə /
                    mövqe ikinci dəfə istifadə olunarsa API rədd edəcək.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="shelf-level" className={labelClass}>
                      Səviyyə *
                    </label>
                    <input
                      id="shelf-level"
                      type="number"
                      required
                      min={1}
                      step={1}
                      inputMode="numeric"
                      placeholder="2"
                      value={form.level}
                      onChange={(e) => set('level', e.target.value)}
                      className={`${inputClass} font-mono`}
                    />
                  </div>

                  <div>
                    <label htmlFor="shelf-position" className={labelClass}>
                      Mövqe *
                    </label>
                    <input
                      id="shelf-position"
                      type="number"
                      required
                      min={1}
                      step={1}
                      inputMode="numeric"
                      placeholder="5"
                      value={form.position}
                      onChange={(e) => set('position', e.target.value)}
                      className={`${inputClass} font-mono`}
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="shelf-product" className={labelClass}>
                    Təyin olunmuş məhsul
                  </label>
                  <select
                    id="shelf-product"
                    value={form.product_id}
                    onChange={(e) => set('product_id', e.target.value)}
                    className={inputClass}
                  >
                    <option value="">— boş mövqe (məhsul təyin olunmayıb) —</option>
                    {[...products]
                      .sort((a, b) => a.name.localeCompare(b.name, 'az'))
                      .map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.name} ({product.barcode})
                        </option>
                      ))}
                  </select>
                  <p className="mt-1 text-[11px] text-muted">
                    Təyin olunmuş məhsul kataloqdan silinə bilməz — əvvəlcə buradan çıxarın.
                  </p>
                </div>

                {formError && (
                  <p
                    role="alert"
                    className="rounded-lg border px-3 py-2 text-[11.5px] font-bold"
                    style={{
                      borderColor: 'var(--bad-dot)',
                      color: 'var(--bad)',
                      backgroundColor: 'var(--g-panel)',
                    }}
                  >
                    {formError}
                  </p>
                )}

                <div className="flex items-center justify-end gap-2.5 border-t border-hair pt-4">
                  <button type="button" onClick={closeForm} className="btn-g">
                    Ləğv et
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="rounded-[11px] bg-coke px-4 py-2 text-xs font-extrabold text-white
                               transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {saving ? 'Yazılır…' : editing === 'new' ? 'Mövqeyi yarat' : 'Yadda saxla'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </ModalPortal>
      )}

      {/* ==================================================================== */}
      {/* SİLMƏ TƏSDİQİ                                                        */}
      {/* ==================================================================== */}
      {pendingDelete && (
        <ModalPortal>
          <div className="modal-veil fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4 sm:p-6">
            <div
              ref={confirmRef}
              role="dialog"
              aria-modal="true"
              aria-label="Rəf mövqesini silməyi təsdiqlə"
              className="glass-pop my-auto w-full max-w-md overflow-hidden rounded-card"
            >
              <div className="flex items-start gap-3 p-5">
                <span
                  className="grid h-9 w-9 flex-none place-items-center rounded-[11px]"
                  style={{ backgroundColor: 'var(--g-panel)', color: 'var(--warn)' }}
                >
                  <AlertTriangle className="h-4 w-4" strokeWidth={2} />
                </span>
                <div className="min-w-0">
                  <h3 className="text-[13px] font-extrabold text-ink">
                    "{slotLabel(pendingDelete)}" silinsin?
                  </h3>
                  <p className="mt-1 text-[11.5px] text-muted">
                    {pendingDelete.product_id
                      ? 'Bu mövqeyə təyin olunmuş məhsul silinməyəcək — yalnız xəritədən çıxacaq.'
                      : 'Mövqe xəritədən çıxacaq. Bu əməliyyat geri qaytarılmır.'}
                  </p>

                  {deleteError && (
                    <p
                      role="alert"
                      className="mt-3 rounded-lg border px-3 py-2 text-[11.5px] font-bold"
                      style={{
                        borderColor: 'var(--bad-dot)',
                        color: 'var(--bad)',
                        backgroundColor: 'var(--g-panel)',
                      }}
                    >
                      {deleteError}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2.5 border-t border-hair p-4">
                <button type="button" onClick={closeConfirm} className="btn-g">
                  Ləğv et
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmDelete()}
                  disabled={deleting}
                  className="rounded-[11px] px-4 py-2 text-xs font-extrabold text-white
                             transition-opacity hover:opacity-90 disabled:opacity-50"
                  style={{ backgroundColor: 'var(--bad-dot)' }}
                >
                  {deleting ? 'Silinir…' : 'Bəli, sil'}
                </button>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </div>
  );
};

/** OSA şeridinin bir düyməsi (dalğa 1.4) — dörd eyni mətn yox, bir yer. */
const MetricTile: React.FC<{ label: string; value: string; hint: string }> = ({
  label,
  value,
  hint,
}) => (
  <div
    className="min-w-[140px] flex-1 rounded-[11px] border border-hair p-3"
    style={{ backgroundColor: 'var(--g-panel)' }}
  >
    <div className="text-[10.5px] font-bold uppercase tracking-[.06em] text-muted">{label}</div>
    <div className="mt-1 font-mono text-[17px] font-extrabold tracking-[-.02em] text-ink">
      {value}
    </div>
    <div className="mt-0.5 text-[10.5px] text-muted">{hint}</div>
  </div>
);
