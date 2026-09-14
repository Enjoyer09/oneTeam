import React, { useState } from 'react';
import { Store as StoreIcon, MapPin, Search, X, Inbox } from 'lucide-react';
import { Store, Submission } from '../types';

interface StoreDirectoryProps {
  stores: Store[];
  submissions: Submission[];
}

export const StoreDirectory: React.FC<StoreDirectoryProps> = ({ stores, submissions }) => {
  const [searchTerm, setSearchTerm] = useState('');

  const query = searchTerm.trim().toLowerCase();

  const filteredStores = stores.filter(
    (s) =>
      s.name.toLowerCase().includes(query) ||
      s.store_code.toLowerCase().includes(query) ||
      s.city.toLowerCase().includes(query),
  );

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

        <div className="relative w-full md:w-[300px] md:flex-none">
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
                : 'Mağazalar sistemə əlavə olunan kimi burada siyahılanacaq.'}
            </p>
            {query && (
              <button type="button" onClick={() => setSearchTerm('')} className="btn-g mt-1">
                Axtarışı təmizlə
              </button>
            )}
          </div>
        ) : (
          <div className="reflow-scroll overflow-x-auto px-2 pb-2.5 sm:px-3">
            <table className="tbl-g reflow reflow-stores lg:min-w-[760px]">
              <thead>
                <tr>
                  <th>Mağaza Kodu</th>
                  <th>Filial Adı</th>
                  <th>Ünvan / Şəhər</th>
                  <th>Cəmi Audit</th>
                  <th>Uyğunluq</th>
                  <th className="text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredStores.map((store) => {
                  const storeSubs = submissions.filter((s) => s.store_id === store.id);
                  const totalAudits = storeSubs.length;
                  const approvedCount = storeSubs.filter((s) => s.status === 'approved').length;
                  const compliancePercent =
                    totalAudits > 0 ? Math.round((approvedCount / totalAudits) * 100) : 100;

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
                        <span className="st-g st-ok">
                          <span className="dot" />
                          Aktiv
                        </span>
                      </td>
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
    </div>
  );
};
