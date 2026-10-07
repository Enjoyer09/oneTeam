import React, { useState } from 'react';
import { Barcode, Search, X, Inbox, Plus, Pencil, Trash2, AlertTriangle } from 'lucide-react';
import { Product } from '../types';
import { ModalPortal } from './ui/ModalPortal';
import { useModalA11y } from '../lib/useModalA11y';

interface ProductCatalogProps {
  products: Product[];
  /** Yeni SKU yaradır. Uğursuzluqda mesajı forma göstərir. */
  onCreate: (data: ProductFormValues) => Promise<unknown>;
  onUpdate: (id: string, changes: Partial<Product>) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  /** Merchandiser üçün false — API onsuz da rədd edir. */
  canEdit: boolean;
}

/**
 * Formanın öz forması, panelin snake/spell-ified sahələri ilə.
 *
 * Bütün sahələr mətn: boş ölçü `''` oxunur, `undefined` yox — API-yə
 * göndərərkən boş dəyər silinir (undefined), beləliklə "istifadəçi
 * boş buraxdı" ilə "sahəni göndərmədi" fərqi qorunur.
 */
export interface ProductFormValues {
  barcode: string;
  name: string;
  size: string;
  variant: string;
}

const EMPTY_FORM: ProductFormValues = { barcode: '', name: '', size: '', variant: '' };

function toFormValues(product: Product): ProductFormValues {
  return {
    barcode: product.barcode,
    name: product.name,
    size: product.size ?? '',
    variant: product.variant ?? '',
  };
}

export const ProductCatalog: React.FC<ProductCatalogProps> = ({
  products,
  onCreate,
  onUpdate,
  onDelete,
  canEdit,
}) => {
  const [searchTerm, setSearchTerm] = useState('');

  /** null = bağlı; 'new' və ya redaktə olunan məhsul. */
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [form, setForm] = useState<ProductFormValues>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<Product | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const modalRef = useModalA11y<HTMLDivElement>(editing !== null, () => closeForm());
  const confirmRef = useModalA11y<HTMLDivElement>(pendingDelete !== null, () => closeConfirm());

  const query = searchTerm.trim().toLowerCase();

  const filtered = products.filter(
    (p) =>
      p.barcode.includes(query) ||
      p.name.toLowerCase().includes(query) ||
      (p.size ?? '').toLowerCase().includes(query) ||
      (p.variant ?? '').toLowerCase().includes(query),
  );

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setEditing('new');
  }

  function openEdit(product: Product) {
    setForm(toFormValues(product));
    setFormError(null);
    setEditing(product);
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

  const set = <K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError(null);

    // Boş sahə göndərilmir (undefined), silinmir: PATCH-də "boşaltmaq" üçün
    // forma sahəni boş göndərməməlidir — hələlik bütün sahələr create-də
    // gəlir və edit-də doldurulur; ponytail: ayrıca "sahəni boşalt" düyməsi
    // əlavə olunsun, nə vaxt istifadəçi boş ölçü saxlamaq istəsin.
    const payload = {
      barcode: form.barcode.trim(),
      name: form.name.trim(),
      size: form.size.trim() || undefined,
      variant: form.variant.trim() || undefined,
    };

    try {
      if (editing === 'new') {
        await onCreate(form);
      } else if (editing) {
        await onUpdate(editing.id, payload);
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

  return (
    <div className="stagger-g flex flex-col gap-4 sm:gap-5">
      {/* ── Başlıq + axtarış ──────────────────────────────────────────────── */}
      <div className="glass-card flex flex-col gap-3.5 rounded-card p-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-extrabold tracking-[-.02em] text-ink">
            Məhsul Kataloqu (SKU)
          </h3>
          <p className="mt-0.5 text-[11px] text-muted">
            Skanerilən barkodun həll etdiyi məhsul identiteti — ad, ölçü, variant
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
              aria-label="Məhsul axtarışı"
              placeholder="Barkod, ad, ölçü..."
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
              <span>Yeni məhsul</span>
            </button>
          )}
        </div>
      </div>

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
              {query ? 'Uyğun məhsul tapılmadı' : 'Hələ məhsul qeydiyyatda deyil'}
            </h4>
            <p className="max-w-[40ch] text-[11.5px] text-muted">
              {query
                ? 'Barkodu tam yazmağı və ya axtarış sözünü qısaltmağı sınayın.'
                : 'Yuxarıdaki "Yeni məhsul" düyməsi ilə ilk SKU-nu əlavə edin.'}
            </p>
            {query ? (
              <button type="button" onClick={() => setSearchTerm('')} className="btn-g mt-1">
                Axtarışı təmizlə
              </button>
            ) : (
              canEdit && (
                <button type="button" onClick={openCreate} className="btn-g mt-1">
                  <Plus className="h-3.5 w-3.5" strokeWidth={2.4} />
                  Yeni məhsul
                </button>
              )
            )}
          </div>
        ) : (
          <div className="reflow-scroll overflow-x-auto px-2 pb-2.5 sm:px-3">
            <table className="tbl-g reflow lg:min-w-[720px]">
              <thead>
                <tr>
                  <th>Barkod</th>
                  <th>Məhsul Adı</th>
                  <th>Ölçü</th>
                  <th>Variant</th>
                  <th>Yaradılma</th>
                  {canEdit && <th className="text-right">Əməliyyat</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((product) => (
                  <tr key={product.id}>
                    <td>
                      <span className="chip-g font-mono">{product.barcode}</span>
                    </td>

                    <td>
                      <div className="flex items-center gap-2">
                        <Barcode className="h-4 w-4 flex-none text-coke" strokeWidth={1.9} />
                        <span className="text-[12px] font-bold tracking-[-.01em] text-ink">
                          {product.name}
                        </span>
                      </div>
                    </td>

                    <td className="text-[11.5px] text-ink-2">{product.size ?? '—'}</td>
                    <td className="text-[11.5px] text-ink-2">{product.variant ?? '—'}</td>
                    <td className="text-[11.5px] text-muted">
                      {product.created_at ? product.created_at.slice(0, 10) : '—'}
                    </td>

                    {canEdit && (
                      <td className="text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => openEdit(product)}
                            aria-label={`${product.name} — redaktə et`}
                            className="grid h-7 w-7 place-items-center rounded-md text-ink-2
                                       transition-colors hover:bg-[var(--g-panel)] hover:text-ink"
                          >
                            <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDeleteError(null);
                              setPendingDelete(product);
                            }}
                            aria-label={`${product.name} — sil`}
                            className="grid h-7 w-7 place-items-center rounded-md text-ink-2
                                       transition-colors hover:bg-[var(--g-panel)] hover:text-[var(--bad)]"
                          >
                            <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {filtered.length > 0 && (
        <p className="px-1 text-[11px] text-muted">
          {query
            ? `${filtered.length} / ${products.length} məhsul göstərilir`
            : `${products.length} məhsul`}
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
              aria-label={editing === 'new' ? 'Yeni məhsul yarat' : 'Məhsulu redaktə et'}
              className="glass-pop my-auto w-full max-w-lg overflow-hidden rounded-card"
            >
              <div className="flex items-center justify-between border-b border-hair bg-[var(--g-panel)] p-5">
                <div>
                  <h3 className="text-sm font-extrabold text-ink sm:text-base">
                    {editing === 'new' ? 'Yeni Məhsul Əlavə Et' : 'Məhsul Məlumatlarını Redaktə Et'}
                  </h3>
                  <p className="text-xs text-muted">
                    Barkod sahədə skanerlənən kodun məhsula həllidir
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
                  <label className={labelClass}>Barkod *</label>
                  <input
                    type="text"
                    required
                    inputMode="numeric"
                    pattern="[0-9]{8,14}"
                    title="8–14 rəqəm (məsələn: 4860059000017)"
                    placeholder="4860059000017"
                    value={form.barcode}
                    onChange={(e) => set('barcode', e.target.value.replace(/\D/g, ''))}
                    className={`${inputClass} font-mono`}
                  />
                  <p className="mt-1 text-[11px] text-muted">
                    Yalnız rəqəm, 8–14 xana. Köhnə barkodu dəyişmək digər məhsulunki ilə toşuşarsa
                    API rədd edəcək.
                  </p>
                </div>

                <div>
                  <label className={labelClass}>Məhsul Adı *</label>
                  <input
                    type="text"
                    required
                    placeholder="Coca-Cola 0.5L Şüşə"
                    value={form.name}
                    onChange={(e) => set('name', e.target.value)}
                    className={inputClass}
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className={labelClass}>Ölçü</label>
                    <input
                      type="text"
                      placeholder="0.5 L"
                      value={form.size}
                      onChange={(e) => set('size', e.target.value)}
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className={labelClass}>Variant</label>
                    <input
                      type="text"
                      placeholder="Zero"
                      value={form.variant}
                      onChange={(e) => set('variant', e.target.value)}
                      className={inputClass}
                    />
                  </div>
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
                    {saving ? 'Yazılır…' : editing === 'new' ? 'Məhsulu yarat' : 'Yadda saxla'}
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
              aria-label="Məhsulu silməyi təsdiqlə"
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
                    Barkod <span className="font-mono">{pendingDelete.barcode}</span>. Bu əməliyyat
                    geri qaytarılmır.
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
