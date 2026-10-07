import React, { useMemo, useState } from 'react';
import {
  Store as StoreIcon,
  MapPin,
  Search,
  X,
  Inbox,
  Plus,
  Pencil,
  Trash2,
  AlertTriangle,
} from 'lucide-react';
import { Store, Submission } from '../types';
import { ModalPortal } from './ui/ModalPortal';
import { useModalA11y } from '../lib/useModalA11y';

interface StoreDirectoryProps {
  stores: Store[];
  submissions: Submission[];
  /** Creates a store. Rejects with a message the caller shows. */
  onCreate: (data: StoreFormValues) => Promise<unknown>;
  onUpdate: (id: string, changes: Partial<Store>) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  /** False for a signed-in merchandiser — the API refuses them anyway. */
  canEdit: boolean;
}

/**
 * The form's own shape, in the panel's snake_case.
 *
 * Coordinates are strings here and numbers in the API: an empty number input
 * reads as `''`, not as `0`, and converting at the edge of the form is what
 * keeps "the user left it blank" distinguishable from "the user typed 0".
 */
export interface StoreFormValues {
  store_code: string;
  name: string;
  chain_name: string;
  store_format: string;
  address: string;
  city: string;
  latitude: string;
  longitude: string;
  is_active: boolean;
}

const EMPTY_FORM: StoreFormValues = {
  store_code: '',
  name: '',
  chain_name: 'Bravo',
  store_format: 'supermarket',
  address: '',
  city: 'Bakı',
  latitude: '',
  longitude: '',
  is_active: true,
};

const STORE_FORMAT_LABELS: Record<string, string> = {
  hypermarket: 'Hipermarket',
  supermarket: 'Supermarket',
  express: 'Ekspres',
  convenience: 'Kiçik mağaza',
};

/**
 * Turns a `GeolocationPositionError` into something an operator can act on.
 *
 * The browser reports three failures with three different remedies — a refused
 * permission is a settings change, an unavailable position is a device setting,
 * a timeout is worth retrying. Collapsing them into "mövqe alınmadı" would
 * leave the operator with nothing to do, which is the same reasoning the mobile
 * login screen uses for its own three location failures.
 */
function describeGeoError(error: unknown): string {
  const code = (error as { code?: number } | null)?.code;
  if (code === 1) {
    return (
      'Brauzer lokasiya icazəsini rədd etdi. Ünvan sətrindəki kilid işarəsinə klikləyib ' +
      'bu sayt üçün icazə verin.'
    );
  }
  if (code === 2) {
    return 'Mövqe müəyyən edilə bilmədi. Cihazın lokasiya xidməti açıqdırmı?';
  }
  if (code === 3) {
    return 'Mövqe 15 saniyə içində alınmadı. Yenidən cəhd edin.';
  }
  return `Mövqe alına bilmədi: ${error instanceof Error ? error.message : String(error)}`;
}

function toFormValues(store: Store): StoreFormValues {
  return {
    store_code: store.store_code,
    name: store.name,
    chain_name: store.chain_name ?? 'Bravo',
    store_format: store.store_format ?? 'supermarket',
    address: store.address ?? '',
    city: store.city ?? 'Bakı',
    latitude: store.latitude === null ? '' : String(store.latitude),
    longitude: store.longitude === null ? '' : String(store.longitude),
    is_active: store.is_active,
  };
}

export const StoreDirectory: React.FC<StoreDirectoryProps> = ({
  stores,
  submissions,
  onCreate,
  onUpdate,
  onDelete,
  canEdit,
}) => {
  const [searchTerm, setSearchTerm] = useState('');

  /** null = closed; otherwise the store being edited (or 'new'). */
  const [editing, setEditing] = useState<Store | 'new' | null>(null);
  const [form, setForm] = useState<StoreFormValues>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** The "use my current position" control: busy, and what it last reported. */
  const [locating, setLocating] = useState(false);
  const [geoStatus, setGeoStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const [pendingDelete, setPendingDelete] = useState<Store | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const modalRef = useModalA11y<HTMLDivElement>(editing !== null, () => closeForm());
  const confirmRef = useModalA11y<HTMLDivElement>(pendingDelete !== null, () => closeConfirm());

  const query = searchTerm.trim().toLowerCase();

  const filteredStores = stores.filter(
    (s) =>
      s.name.toLowerCase().includes(query) ||
      s.store_code.toLowerCase().includes(query) ||
      s.city.toLowerCase().includes(query),
  );

  /**
   * Audit counts per store, computed once per render of the list.
   *
   * This used to be a `submissions.filter(...)` inside the row loop, which is
   * O(stores × submissions) — fine at three stores and four submissions, less
   * fine at three hundred. The map is built from one pass and read per row.
   */
  const auditsByStore = useMemo(() => {
    const map = new Map<string, { total: number; approved: number }>();
    for (const submission of submissions) {
      const entry = map.get(submission.store_id) ?? { total: 0, approved: 0 };
      entry.total += 1;
      if (submission.status === 'approved') entry.approved += 1;
      map.set(submission.store_id, entry);
    }
    return map;
  }, [submissions]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setGeoStatus(null);
    setEditing('new');
  }

  function openEdit(store: Store) {
    setForm(toFormValues(store));
    setFormError(null);
    setGeoStatus(null);
    setEditing(store);
  }

  function closeForm() {
    setEditing(null);
    setFormError(null);
    setGeoStatus(null);
    setSaving(false);
  }

  function closeConfirm() {
    setPendingDelete(null);
    setDeleteError(null);
    setDeleting(false);
  }

  const set = <K extends keyof StoreFormValues>(key: K, value: StoreFormValues[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;

    setSaving(true);
    setFormError(null);

    try {
      if (editing === 'new') {
        await onCreate(form);
      } else if (editing) {
        await onUpdate(editing.id, {
          store_code: form.store_code,
          name: form.name,
          chain_name: form.chain_name,
          store_format: form.store_format,
          address: form.address,
          city: form.city,
          latitude: Number(form.latitude),
          longitude: Number(form.longitude),
          is_active: form.is_active,
        });
      }
      closeForm();
    } catch (error) {
      // Kept inside the modal rather than shown as a toast: the form is still
      // open, and an error the user cannot see next to the field that caused it
      // is an error they will fix by guessing.
      setFormError(error instanceof Error ? error.message : String(error));
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
      setDeleting(false);
    }
  }

  /**
   * Fills the two coordinate fields from the browser's own position.
   *
   * WHY THIS EXISTS
   * ---------------
   * A store's coordinates decide whether a field worker's audit is accepted:
   * the geofence compares the device's fix against them, and a wrong pair
   * rejects every photo from that store with a message the worker cannot act
   * on. The only way to enter them was to right-click a point in Google Maps
   * and copy two numbers by hand — and on 2026-09-20 that is exactly how a
   * demo store ended up at coordinates nobody was standing on, so an operator
   * testing from their desk was refused with "Siz mağaza ərazisində
   * deyilsiniz" and could not sign in at all.
   *
   * WHAT IT DOES NOT DO
   * -------------------
   * It does not relax the check. The values land in the same form, go through
   * the same `Number()` conversion, and face the same server-side bounds
   * validation (`PortalService.PLAUSIBLE_BOUNDS`), and the operator still has
   * to save. All this removes is the transcription step — which is the part
   * that was wrong.
   */
  async function fillFromCurrentPosition() {
    setLocating(true);
    setGeoStatus(null);

    // Absent outside a secure context, i.e. an `http://` origin other than
    // localhost. Saying so is the point: a button that silently does nothing
    // reads as "the feature is broken" rather than "the page is not https".
    if (!('geolocation' in navigator)) {
      setGeoStatus({
        kind: 'error',
        text:
          'Bu səhifə təhlükəsiz (https) deyil, ona görə brauzer lokasiyanı vermir. ' +
          'Koordinatları Google Maps-dən əl ilə yazın.',
      });
      setLocating(false);
      return;
    }

    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15_000,
          maximumAge: 0,
        });
      });

      // Six decimals, the precision the API's own example uses (`40.385012`).
      // Rounding here rather than in the input keeps the field readable while
      // leaving the value exact enough for a 100 m geofence.
      const latitude = position.coords.latitude.toFixed(6);
      const longitude = position.coords.longitude.toFixed(6);
      setForm((previous) => ({ ...previous, latitude, longitude }));

      setGeoStatus({
        kind: 'ok',
        text:
          `Mövqe götürüldü: ${latitude}, ${longitude} ` +
          `(±${Math.round(position.coords.accuracy)}m). Yadda saxlamağı unutmayın.`,
      });
    } catch (error) {
      setGeoStatus({ kind: 'error', text: describeGeoError(error) });
    } finally {
      setLocating(false);
    }
  }

  const inputClass =
    'w-full px-3 py-2 border border-hair rounded-lg text-xs text-ink bg-[var(--g-card)] ' +
    'focus:outline-none focus:ring-2 focus:ring-[var(--coke-ring)] focus:border-coke/45';
  const labelClass = 'block text-xs font-bold text-ink-2 mb-1';

  return (
    <div className="stagger-g flex flex-col gap-4 sm:gap-5">
      {/* ── Başlıq + axtarış ──────────────────────────────────────────────── */}
      <div className="glass-card flex flex-col gap-3.5 rounded-card p-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-extrabold tracking-[-.02em] text-ink">
            Tərəfdaş Mağazalar Şəbəkəsi
          </h3>
          <p className="mt-0.5 text-[11px] text-muted">
            Coca-Cola vitrin və rəflərinin monitorinq edildiyi retail nöqtələri
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
              aria-label="Mağaza axtarışı"
              placeholder="Filial adı, kod və ya şəhər..."
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
              <span>Yeni mağaza</span>
            </button>
          )}
        </div>
      </div>

      {/* ── Cədvəl ────────────────────────────────────────────────────────── */}
      <div className="glass-card overflow-hidden rounded-card">
        {filteredStores.length === 0 ? (
          <div className="flex flex-col items-center gap-2.5 px-6 py-14 text-center">
            <span
              className="grid h-12 w-12 place-items-center rounded-[14px]"
              style={{ backgroundColor: 'var(--g-panel)', color: 'var(--faint)' }}
            >
              <Inbox className="h-6 w-6" strokeWidth={1.7} />
            </span>
            <h4 className="text-[13px] font-extrabold text-ink">
              {query ? 'Uyğun mağaza tapılmadı' : 'Hələ mağaza qeydiyyatda deyil'}
            </h4>
            <p className="max-w-[40ch] text-[11.5px] text-muted">
              {query
                ? 'Axtarış sözünü qısaltmağı və ya filial kodunu yoxlamağı sınayın.'
                : 'Yuxarıdaki "Yeni mağaza" düyməsi ilə ilk retail nöqtəsini əlavə edin.'}
            </p>
            {query ? (
              <button type="button" onClick={() => setSearchTerm('')} className="btn-g mt-1">
                Axtarışı təmizlə
              </button>
            ) : (
              canEdit && (
                <button type="button" onClick={openCreate} className="btn-g mt-1">
                  <Plus className="h-3.5 w-3.5" strokeWidth={2.4} />
                  Yeni mağaza
                </button>
              )
            )}
          </div>
        ) : (
          <div className="reflow-scroll overflow-x-auto px-2 pb-2.5 sm:px-3">
            <table className="tbl-g reflow reflow-stores lg:min-w-[860px]">
              <thead>
                <tr>
                  <th>Mağaza Kodu</th>
                  <th>Filial Adı</th>
                  <th>Ünvan / Şəhər</th>
                  <th>Format</th>
                  <th>Cəmi Audit</th>
                  <th>Uyğunluq</th>
                  <th className="text-right">Status</th>
                  {canEdit && <th className="text-right">Əməliyyat</th>}
                </tr>
              </thead>
              <tbody>
                {filteredStores.map((store) => {
                  const audits = auditsByStore.get(store.id) ?? { total: 0, approved: 0 };
                  const totalAudits = audits.total;
                  const compliancePercent =
                    totalAudits > 0 ? Math.round((audits.approved / totalAudits) * 100) : 100;

                  const tone =
                    compliancePercent >= 80
                      ? { bar: 'var(--ok-dot)', text: 'var(--ok)' }
                      : compliancePercent >= 50
                        ? { bar: 'var(--warn-dot)', text: 'var(--warn)' }
                        : { bar: 'var(--bad-dot)', text: 'var(--bad)' };

                  return (
                    <tr key={store.id}>
                      <td>
                        <span className="chip-g font-mono">{store.store_code}</span>
                      </td>

                      <td>
                        <div className="flex items-center gap-2">
                          <StoreIcon className="h-4 w-4 flex-none text-coke" strokeWidth={1.9} />
                          <span className="text-[12px] font-bold tracking-[-.01em] text-ink">
                            {store.name}
                          </span>
                        </div>
                      </td>

                      <td>
                        <div className="flex items-center gap-1.5 text-ink-2">
                          <MapPin className="h-3.5 w-3.5 flex-none text-muted" strokeWidth={1.9} />
                          <span className="truncate">{store.address || store.city}</span>
                        </div>
                      </td>

                      <td className="text-[11.5px] text-ink-2">
                        {STORE_FORMAT_LABELS[store.store_format ?? ''] ?? store.store_format ?? '—'}
                      </td>

                      <td className="font-bold text-ink">
                        {totalAudits} <span className="font-normal text-muted">yoxlama</span>
                      </td>

                      <td>
                        <div className="flex items-center gap-2.5">
                          {/* Zolaq + faiz mətni — rəng tək başına məna daşımır */}
                          <span
                            className="h-[6px] w-[88px] flex-none overflow-hidden rounded-full"
                            style={{ backgroundColor: 'var(--hair)' }}
                            role="img"
                            aria-label={`Uyğunluq ${compliancePercent} faiz`}
                          >
                            <span
                              className="block h-full rounded-full transition-[width] duration-400 ease-out"
                              style={{
                                width: `${compliancePercent}%`,
                                backgroundColor: tone.bar,
                              }}
                            />
                          </span>
                          <span
                            className="font-mono text-[11.5px] font-bold tabular-nums"
                            style={{ color: tone.text }}
                          >
                            {compliancePercent}%
                          </span>
                        </div>
                      </td>

                      <td className="text-right">
                        {/* Read from the record. This badge used to be a hardcoded
                            "Aktiv" for every row, so a deactivated store still
                            showed as active — the panel was asserting something
                            it had never checked. */}
                        {store.is_active ? (
                          <span className="st-g st-ok">
                            <span className="dot" />
                            Aktiv
                          </span>
                        ) : (
                          <span className="st-g st-warn">
                            <span className="dot" />
                            Deaktiv
                          </span>
                        )}
                      </td>

                      {canEdit && (
                        <td className="text-right">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => openEdit(store)}
                              aria-label={`${store.name} — redaktə et`}
                              className="grid h-7 w-7 place-items-center rounded-md text-ink-2
                                         transition-colors hover:bg-[var(--g-panel)] hover:text-ink"
                            >
                              <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDeleteError(null);
                                setPendingDelete(store);
                              }}
                              aria-label={`${store.name} — sil`}
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

      {/* Nəticə sayı — istifadəçi filtrasiyanın işlədiyini görür */}
      {filteredStores.length > 0 && (
        <p className="px-1 text-[11px] text-muted">
          {query
            ? `${filteredStores.length} / ${stores.length} mağaza göstərilir`
            : `${stores.length} mağaza`}
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
              aria-label={editing === 'new' ? 'Yeni mağaza yarat' : 'Mağazanı redaktə et'}
              className="glass-pop my-auto w-full max-w-2xl overflow-hidden rounded-card"
            >
              <div className="flex items-center justify-between border-b border-hair bg-[var(--g-panel)] p-5">
                <div>
                  <h3 className="text-sm font-extrabold text-ink sm:text-base">
                    {editing === 'new' ? 'Yeni Mağaza Əlavə Et' : 'Mağaza Məlumatlarını Redaktə Et'}
                  </h3>
                  <p className="text-xs text-muted">
                    Kod və koordinatlar sahə işçisinin fotosunun qəbul olunmasını müəyyən edir
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
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className={labelClass}>Mağaza Kodu *</label>
                    <input
                      type="text"
                      required
                      placeholder="BRAVO_YASAMAL_01"
                      value={form.store_code}
                      onChange={(e) => set('store_code', e.target.value.toUpperCase())}
                      className={`${inputClass} font-mono`}
                    />
                    <p className="mt-1 text-[11px] text-muted">
                      Boşluq olmaz; böyük hərflərlə yazılır.
                    </p>
                  </div>

                  <div>
                    <label className={labelClass}>Filial Adı *</label>
                    <input
                      type="text"
                      required
                      placeholder="Bravo Hypermarket - Yasamal"
                      value={form.name}
                      onChange={(e) => set('name', e.target.value)}
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className={labelClass}>Şəbəkə</label>
                    <input
                      type="text"
                      placeholder="Bravo"
                      value={form.chain_name}
                      onChange={(e) => set('chain_name', e.target.value)}
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className={labelClass}>Mağaza Növü</label>
                    <select
                      value={form.store_format}
                      onChange={(e) => set('store_format', e.target.value)}
                      className={inputClass}
                    >
                      {Object.entries(STORE_FORMAT_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className={labelClass}>Ünvan *</label>
                  <input
                    type="text"
                    required
                    placeholder="Həsən bəy Zərdabi pr. 92, Yasamal"
                    value={form.address}
                    onChange={(e) => set('address', e.target.value)}
                    className={inputClass}
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <label className={labelClass}>Şəhər</label>
                    <input
                      type="text"
                      placeholder="Bakı"
                      value={form.city}
                      onChange={(e) => set('city', e.target.value)}
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className={labelClass}>Enlem (lat) *</label>
                    <input
                      type="number"
                      step="any"
                      required
                      placeholder="40.385012"
                      value={form.latitude}
                      onChange={(e) => set('latitude', e.target.value)}
                      className={`${inputClass} font-mono`}
                    />
                  </div>

                  <div>
                    <label className={labelClass}>Uzunluq (lon) *</label>
                    <input
                      type="number"
                      step="any"
                      required
                      placeholder="49.810541"
                      value={form.longitude}
                      onChange={(e) => set('longitude', e.target.value)}
                      className={`${inputClass} font-mono`}
                    />
                  </div>
                </div>

                {/* Fills both fields from the browser's own position. This is
                    the step that was wrong when the demo store ended up at
                    coordinates nobody was standing on; see
                    `fillFromCurrentPosition` for what it does and does not relax. */}
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      void fillFromCurrentPosition();
                    }}
                    disabled={locating}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-hair bg-[var(--g-card)] px-3 py-2 text-[11px] font-bold text-ink-2 transition hover:border-coke/45 disabled:opacity-50"
                  >
                    <MapPin className="h-3.5 w-3.5" />
                    {locating ? 'Mövqe götürülür…' : 'Cari mövqeyimi götür'}
                  </button>

                  {geoStatus && (
                    <p
                      role={geoStatus.kind === 'error' ? 'alert' : 'status'}
                      className="min-w-0 flex-1 text-[11px] leading-relaxed"
                      style={{
                        color: geoStatus.kind === 'error' ? 'var(--bad)' : 'var(--ok)',
                      }}
                    >
                      {geoStatus.text}
                    </p>
                  )}
                </div>

                <p className="rounded-lg border border-hair bg-[var(--g-panel)] px-3 py-2 text-[11px] text-muted">
                  Koordinatı Google Maps-də mağazanın üzərinə sağ klikləyib kopyalayın. Səhv onluq
                  nöqtə geofence-i söndürür və həmin mağazadan heç bir foto qəbul olunmaz.
                </p>

                <label className="flex cursor-pointer items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={form.is_active}
                    onChange={(e) => set('is_active', e.target.checked)}
                    className="h-4 w-4 accent-[var(--coke)]"
                  />
                  <span className="text-xs font-bold text-ink-2">
                    Aktiv — sahə işçilərinə göndərilir
                  </span>
                </label>

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
                    {saving ? 'Yazılır…' : editing === 'new' ? 'Mağazanı yarat' : 'Yadda saxla'}
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
              aria-label="Mağazanı silməyi təsdiqlə"
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
                    "{pendingDelete.name}" silinsin?
                  </h3>
                  <p className="mt-1 text-[11.5px] text-muted">
                    Mağaza kodu <span className="font-mono">{pendingDelete.store_code}</span>. Bu
                    əməliyyat geri qaytarılmır.
                  </p>
                  <p className="mt-1.5 text-[11.5px] text-muted">
                    Mağazanın tapşırıqları varsa, silinmə yerinə onu <b>deaktiv</b> etmək düzgün
                    seçimdir — beləcə tarixçə qalır, yeni iş göndərilmir.
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
