/**
 * oneTeam Supervisor Portal — panel key management
 * ============================================================================
 *
 * Administrator-only. Two jobs: show who currently holds a key, and mint or
 * revoke one.
 *
 * THE MINTED KEY IS SHOWN ONCE AND THEN GONE
 * ------------------------------------------
 * Only a SHA-256 is stored, so there is no screen anywhere that can show it
 * again — not this one, not a database query, not a backup. That is the point,
 * and it is also why this dialog refuses to close on a click-away while a fresh
 * key is on screen: dismissing it by accident would mean revoking the key and
 * starting again.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, KeyRound, Loader2, RefreshCw, Trash2, X } from 'lucide-react';
import {
  fetchKeys,
  mintKey,
  revokeKey,
  revokeUserKeys,
  PanelAuthError,
  type PanelKeyRow,
  type PanelUserRow,
} from '../lib/panelAuth';
import { useModalA11y } from '../lib/useModalA11y';

interface PanelKeysModalProps {
  onClose: () => void;
  /** Called after a change that could alter whether a login is required. */
  onChanged: () => void;
}

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Administrator',
  SUPERVISOR: 'Supervayzer',
  MERCHANDISER: 'Merchandiser',
};

function when(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('az-AZ', { timeZone: 'Asia/Baku' });
}

export const PanelKeysModal: React.FC<PanelKeysModalProps> = ({ onClose, onChanged }) => {
  const [keys, setKeys] = useState<PanelKeyRow[]>([]);
  const [users, setUsers] = useState<PanelUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** A key that has just been minted and has not been acknowledged yet. */
  const [freshKey, setFreshKey] = useState<{ token: string; userId: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedUser, setSelectedUser] = useState('');
  const modalRef = useModalA11y<HTMLDivElement>(true, () => {
    if (!freshKey) onClose();
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchKeys();
      setKeys(result.keys);
      setUsers(result.users);
      setSelectedUser((current) => current || result.users[0]?.id || '');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<void>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof PanelAuthError ? caught.message : `${failure} ${String(caught)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleMint = () =>
    run(async () => {
      if (!selectedUser) throw new Error('İstifadəçi seçin.');
      const label = users.find((user) => user.id === selectedUser)?.fullName ?? '';
      const issued = await mintKey(selectedUser, `${label} — panel girişi`);
      setFreshKey({ token: issued.token, userId: issued.userId });
      setCopied(false);
      await load();
      onChanged();
    }, 'Açar yaradıla bilmədi.');

  const handleRevoke = (row: PanelKeyRow) =>
    run(async () => {
      await revokeKey(row.hashPrefix);
      await load();
      onChanged();
    }, 'Açar ləğv edilə bilmədi.');

  const handleRevokeUser = (user: PanelUserRow) =>
    run(async () => {
      await revokeUserKeys(user.id);
      await load();
      onChanged();
    }, 'Açarlar ləğv edilə bilmədi.');

  const copyFreshKey = async () => {
    if (!freshKey) return;
    try {
      await navigator.clipboard.writeText(freshKey.token);
      setCopied(true);
    } catch {
      // Clipboard access is denied in some contexts. The key is on screen and
      // selectable, which is the fallback that always works.
      setError('Kopyalamaq alınmadı — açarı əl ilə seçib kopyalayın.');
    }
  };

  const liveKeys = keys.filter((row) => row.live);
  const revokedKeys = keys.filter((row) => !row.live);

  return (
    <div className="modal-veil fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Panel giriş açarları"
        className="glass-pop modal-admin w-full max-w-[720px] rounded-[18px] p-5 text-ink sm:p-6"
      >
        <div className="mb-4 flex items-start gap-3">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[11px] bg-[var(--primary-soft)] text-primary">
            <KeyRound className="h-4 w-4" strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-extrabold tracking-[-.03em]">Panel giriş açarları</h2>
            <p className="mt-0.5 text-[11px] text-muted">
              Hər adam üçün ayrı açar. Açar yalnız yaradıldığı anda göstərilir.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Bağla"
            className="iconbtn-g"
            disabled={Boolean(freshKey)}
            title={freshKey ? 'Əvvəlcə yeni açarı köçürün' : 'Bağla'}
          >
            <X className="h-[17px] w-[17px]" strokeWidth={2} />
          </button>
        </div>

        {error && (
          <div className="mb-4 flex gap-2.5 rounded-[12px] border border-[var(--bad-bd)] bg-[var(--bad-bg)] p-3">
            <AlertTriangle className="mt-px h-4 w-4 flex-shrink-0 text-[var(--bad)]" strokeWidth={2} />
            <p className="text-[11.5px] leading-relaxed text-ink">{error}</p>
          </div>
        )}

        {/* The one and only sighting of a new key. */}
        {freshKey && (
          <div className="mb-4 rounded-[14px] border border-[var(--ok-bd)] bg-[var(--ok-bg)] p-3.5">
            <b className="block text-[12px] font-extrabold text-[var(--ok)]">
              Açar yaradıldı — indi köçürün
            </b>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink">
              Bu açar <b className="font-bold">bir daha göstərilməyəcək</b>. Verilənlər bazasında
              yalnız onun şifrələnmiş barmaq izi saxlanılır.
            </p>
            <div className="mt-2.5 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-[10px] bg-[var(--modal-field)] px-3 py-2 font-mono text-[12px]">
                {freshKey.token}
              </code>
              <button
                type="button"
                onClick={() => void copyFreshKey()}
                className="btn-g flex-shrink-0"
              >
                {copied ? (
                  <Check className="h-4 w-4" strokeWidth={2.2} />
                ) : (
                  <Copy className="h-4 w-4" strokeWidth={2.1} />
                )}
                {copied ? 'Kopyalandı' : 'Kopyala'}
              </button>
            </div>
            <button type="button" onClick={() => setFreshKey(null)} className="btn-g mt-2.5">
              <Check className="h-4 w-4" strokeWidth={2.2} />
              Açarı köçürdüm, bağla
            </button>
          </div>
        )}

        {/* Mint */}
        <div className="mb-4 rounded-[14px] bg-[var(--g-panel)] p-3.5">
          <label
            htmlFor="panel-key-user"
            className="mb-1.5 block text-[11px] font-bold uppercase tracking-[.06em] text-muted"
          >
            Yeni açar üçün istifadəçi
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              id="panel-key-user"
              value={selectedUser}
              onChange={(event) => setSelectedUser(event.target.value)}
              className="min-w-0 flex-1 rounded-[11px] border border-hair bg-[var(--modal-field)]
                         px-3 py-2 text-[12.5px] text-ink outline-none
                         focus:border-primary-500/45 focus:ring-2 focus:ring-[var(--primary-ring)]"
            >
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.fullName} — {ROLE_LABEL[user.role] ?? user.role}
                  {user.liveKeys > 0 ? ` (${user.liveKeys} aktiv açar)` : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleMint()}
              disabled={busy || !selectedUser}
              className="btn-g btn-g-primary flex-shrink-0 justify-center disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.1} />
              ) : (
                <KeyRound className="h-4 w-4" strokeWidth={2.1} />
              )}
              Açar yarat
            </button>
          </div>
        </div>

        {/* Live keys */}
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="text-[12px] font-extrabold tracking-[-.02em]">
            Aktiv açarlar ({liveKeys.length})
          </h3>
          <button type="button" onClick={() => void load()} className="btn-g" disabled={loading}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.1} />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={2.1} />
            )}
            Yenilə
          </button>
        </div>

        {liveKeys.length === 0 ? (
          <p className="rounded-[12px] bg-[var(--g-panel)] p-3 text-[11.5px] text-muted">
            Hələ aktiv açar yoxdur. Yuxarıdan yaradın — ilk açar yaradılan kimi panel giriş tələb
            etməyə başlayacaq.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11.5px]">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1.5 pr-3 font-bold">İstifadəçi</th>
                  <th className="py-1.5 pr-3 font-bold">Açar</th>
                  <th className="py-1.5 pr-3 font-bold">Yaradılıb</th>
                  <th className="py-1.5 pr-3 font-bold">Son istifadə</th>
                  <th className="py-1.5 font-bold" />
                </tr>
              </thead>
              <tbody>
                {liveKeys.map((row) => (
                  <tr key={row.hashPrefix} className="border-t border-hair">
                    <td className="py-2 pr-3">
                      <span className="font-bold">{row.userName ?? row.userId}</span>
                      {row.current && (
                        <span className="ml-1.5 rounded-full bg-[var(--ok-bg)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--ok)]">
                          bu cihaz
                        </span>
                      )}
                      {row.label && (
                        <span className="block text-[11px] text-muted">{row.label}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 font-mono text-muted">{row.hashPrefix}…</td>
                    <td className="py-2 pr-3 text-muted">{when(row.createdAt)}</td>
                    <td className="py-2 pr-3 text-muted">{when(row.lastSeenAt)}</td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => void handleRevoke(row)}
                        disabled={busy || row.current}
                        title={
                          row.current
                            ? 'Cari sessiyanı çıxış düyməsi ilə bitirin'
                            : 'Bu açarı ləğv et'
                        }
                        className="btn-g disabled:opacity-40"
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={2.1} />
                        Ləğv et
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Per-person revocation — what "they left" means */}
        {users.filter((user) => user.liveKeys > 0).length > 0 && (
          <div className="mt-4 rounded-[12px] bg-[var(--g-panel)] p-3">
            <b className="block text-[11.5px] font-extrabold">Bir adamın bütün açarlarını kəsmək</b>
            <p className="mt-0.5 text-[11px] text-muted">
              İşdən çıxanda istifadə olunur. Ləğv edilmiş açar silinmir — nə vaxt kəsildiyi qeyd
              olaraq qalır.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {users
                .filter((user) => user.liveKeys > 0)
                .map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    onClick={() => void handleRevokeUser(user)}
                    disabled={busy}
                    className="btn-g disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={2.1} />
                    {user.fullName} ({user.liveKeys})
                  </button>
                ))}
            </div>
          </div>
        )}

        {revokedKeys.length > 0 && (
          <p className="mt-3 text-[11px] text-muted">
            Ləğv edilmiş açarlar: {revokedKeys.length}. Onlar işləmir, amma qeyd kimi saxlanılır.
          </p>
        )}
      </div>
    </div>
  );
};
