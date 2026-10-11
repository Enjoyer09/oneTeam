/**
 * oneTeam Supervisor Portal — people management
 * ============================================================================
 *
 * Administrator-only. Who is in the system, what each of them may do, and how
 * to add somebody or take somebody out.
 *
 * WHY THIS SCREEN HAD TO EXIST
 * ----------------------------
 * "Hər adama öz açarı" — a key per person — was already the login model, and
 * the key screen could already mint one. What it could not do was add the
 * *person*: the only people who existed were the three in the seed. So the
 * operator could hand out keys, but only to the same three names.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not offer a delete for somebody the server will refuse. A person who
 * has submitted shelf audits is part of the audit trail and `ON DELETE
 * RESTRICT` keeps them; the API reports that as `blockedBy` and this screen
 * shows the reason next to a disabled button rather than letting the operator
 * discover it from a 409. The right action for that person is revoking their
 * keys, which is offered instead and which actually cuts off access.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  KeyRound,
  Loader2,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import {
  createUser,
  deleteUser,
  fetchUsers,
  mintKey,
  revokeUserKeys,
  updateUser,
  PanelAuthError,
  type ManagedUserRow,
  type UserBlockReason,
} from '../lib/panelAuth';
import { useModalA11y } from '../lib/useModalA11y';

interface PanelUsersModalProps {
  onClose: () => void;
  /** Called after anything that could change who may sign in. */
  onChanged: () => void;
}

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Administrator',
  SUPERVISOR: 'Supervayzer',
  MERCHANDISER: 'Merchandiser',
  STORE_STAFF: 'Mağaza işçisi',
};

/**
 * What each role may do, in the operator's words.
 *
 * Written out rather than left as a bare enum because the whole point of this
 * screen is that somebody who does not read code has to decide which one to
 * pick, and "MERCHANDISER" alone does not say whether that person can approve
 * their own photo. It cannot — that is the rule this session added — and the
 * sentence says so.
 */
const ROLE_HELP: Record<string, string> = {
  ADMIN: 'Hər şey: açarlar, istifadəçilər, rollar, mağaza və tapşırıqlar.',
  SUPERVISOR: 'Mağaza və tapşırıq yaradır, auditi təsdiqləyir və ya imtina edir.',
  MERCHANDISER: 'Sahədə işi icra edir və foto göndərir. Öz işini təsdiqləyə bilməz.',
  STORE_STAFF: 'Mağaza tərəfi. İcra edir, idarəetmə hüququ yoxdur.',
};

/** The sentence shown next to a person the server will not let you remove. */
const BLOCK_REASON: Record<UserBlockReason, string> = {
  SELF: 'Bu, sizin öz hesabınızdır. Başqa administrator silməlidir.',
  LAST_ADMIN: 'Son administrator silinə bilməz — əvvəlcə başqasını administrator edin.',
  HAS_SUBMISSIONS: 'Audit təqdimatı var, ona görə silinmir. Açarlarını ləğv edin.',
  UNKNOWN: 'Təqdimat sayı oxuna bilmədi — silmək təhlükəlidir, əvvəlcə yeniləyin.',
};

interface DraftUser {
  fullName: string;
  email: string;
  role: string;
  phone: string;
}

const EMPTY_DRAFT: DraftUser = {
  fullName: '',
  email: '',
  role: 'MERCHANDISER',
  phone: '',
};

export const PanelUsersModal: React.FC<PanelUsersModalProps> = ({ onClose, onChanged }) => {
  const [users, setUsers] = useState<ManagedUserRow[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** The "add a person" form. Open by default when there is nobody yet. */
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<DraftUser>(EMPTY_DRAFT);

  /** The person currently being edited, and their pending values. */
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ fullName: string; role: string; phone: string }>({
    fullName: '',
    role: '',
    phone: '',
  });

  /** A key minted from this screen, shown once and not yet acknowledged. */
  const [freshKey, setFreshKey] = useState<{ token: string; forWhom: string } | null>(null);

  /**
   * A delete or key-revoke awaiting confirmation. Both cut a person's access
   * and the delete is irreversible, so — like the store/task deletes elsewhere
   * — they ask first instead of firing on the first click.
   */
  const [confirm, setConfirm] = useState<{
    kind: 'delete' | 'revoke';
    user: ManagedUserRow;
  } | null>(null);

  // Focus trap + restore + dialog Escape, shared with the other modals. Escape
  // is guarded so it cannot dismiss the dialog — and lose the one-time key —
  // while a freshly minted key is still on screen.
  const dialogRef = useModalA11y<HTMLDivElement>(true, () => {
    if (!freshKey) onClose();
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchUsers();
      setUsers(result.users);
      setRoles(result.roles);
      setDraft((current) => ({
        ...current,
        role: current.role || result.roles.find((role) => role === 'MERCHANDISER') || '',
      }));
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
    setNotice(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof PanelAuthError ? caught.message : `${failure} ${String(caught)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = () =>
    run(async () => {
      if (!draft.fullName.trim()) throw new Error('Ad və soyad tələb olunur.');
      const created = await createUser({
        fullName: draft.fullName.trim(),
        email: draft.email.trim() || undefined,
        role: draft.role,
        phone: draft.phone.trim() || undefined,
      });
      setDraft(EMPTY_DRAFT);
      setAdding(false);
      setNotice(`${created.fullName} əlavə olundu. İndi ona açar yarada bilərsiniz.`);
      await load();
      onChanged();
    }, 'İstifadəçi yaradıla bilmədi.');

  const startEditing = (user: ManagedUserRow) => {
    setEditing(user.id);
    setEditDraft({ fullName: user.fullName, role: user.role, phone: user.phone ?? '' });
    setError(null);
    setNotice(null);
  };

  const handleSaveEdit = (user: ManagedUserRow) =>
    run(async () => {
      const changes: { fullName?: string; role?: string; phone?: string } = {};
      if (editDraft.fullName.trim() !== user.fullName) changes.fullName = editDraft.fullName.trim();
      if (editDraft.role !== user.role) changes.role = editDraft.role;
      if (editDraft.phone.trim() !== (user.phone ?? '')) changes.phone = editDraft.phone.trim();

      if (Object.keys(changes).length === 0) {
        setEditing(null);
        return;
      }

      await updateUser(user.id, changes);
      setEditing(null);
      setNotice(
        changes.role
          ? `${user.fullName}: rol ${ROLE_LABEL[user.role] ?? user.role} → ${ROLE_LABEL[changes.role] ?? changes.role}`
          : `${user.fullName} yeniləndi.`,
      );
      await load();
      onChanged();
    }, 'Dəyişiklik yazıla bilmədi.');

  const handleDelete = (user: ManagedUserRow) =>
    run(async () => {
      await deleteUser(user.id);
      setNotice(`${user.fullName} silindi.`);
      await load();
      onChanged();
    }, 'İstifadəçi silinə bilmədi.');

  const handleMint = (user: ManagedUserRow) =>
    run(async () => {
      const issued = await mintKey(user.id, `${user.fullName} — panel girişi`);
      setFreshKey({ token: issued.token, forWhom: user.fullName });
      await load();
      onChanged();
    }, 'Açar yaradıla bilmədi.');

  const handleRevokeKeys = (user: ManagedUserRow) =>
    run(async () => {
      const count = await revokeUserKeys(user.id);
      setNotice(
        count > 0
          ? `${user.fullName}: ${count} açar ləğv edildi.`
          : `${user.fullName}: ləğv ediləcək aktiv açar yox idi.`,
      );
      await load();
      onChanged();
    }, 'Açarlar ləğv edilə bilmədi.');

  const confirmPending = () => {
    const target = confirm;
    if (!target) return;
    setConfirm(null);
    if (target.kind === 'delete') void handleDelete(target.user);
    else void handleRevokeKeys(target.user);
  };

  const copyFreshKey = async () => {
    if (!freshKey) return;
    try {
      await navigator.clipboard.writeText(freshKey.token);
      setNotice('Açar kopyalandı.');
    } catch {
      setError('Kopyalamaq alınmadı — açarı əl ilə seçib kopyalayın.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgba(10,16,32,.34)] p-4 backdrop-blur-[2px] sm:items-center">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="İstifadəçilərin idarə edilməsi"
        className="glass-pop w-full max-w-[820px] rounded-[18px] p-5 text-ink sm:p-6"
      >
        <div className="mb-4 flex items-start gap-3">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[11px] bg-[rgba(10,16,32,.06)]">
            <ShieldCheck className="h-4 w-4" strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-extrabold tracking-[-.03em]">
              İstifadəçilər və rollar
            </h2>
            <p className="mt-0.5 text-[11px] text-muted">
              Kim sistemdədir, nə edə bilər, və kimə açar verilə bilər.
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
          <div className="mb-4 flex gap-2.5 rounded-[12px] border border-[rgba(200,60,60,.28)] bg-[rgba(200,60,60,.07)] p-3">
            <AlertTriangle className="mt-px h-4 w-4 flex-shrink-0 text-[#b23b3b]" strokeWidth={2} />
            <p className="text-[11.5px] leading-relaxed text-ink">{error}</p>
          </div>
        )}

        {notice && !error && (
          <div className="mb-4 flex gap-2.5 rounded-[12px] border border-[rgba(30,140,90,.28)] bg-[rgba(30,140,90,.07)] p-3">
            <Check className="mt-px h-4 w-4 flex-shrink-0 text-[#1c7a4f]" strokeWidth={2.2} />
            <p className="text-[11.5px] leading-relaxed text-ink">{notice}</p>
          </div>
        )}

        {/* Delete / revoke confirmation — both cut access, delete is permanent. */}
        {confirm && (
          <div className="mb-4 rounded-[12px] border border-[rgba(200,60,60,.28)] bg-[rgba(200,60,60,.07)] p-3.5">
            <b className="block text-[12px] font-extrabold text-[#b23b3b]">
              {confirm.kind === 'delete'
                ? `${confirm.user.fullName} silinsin?`
                : `${confirm.user.fullName} — bütün açarları kəsilsin?`}
            </b>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink">
              {confirm.kind === 'delete'
                ? 'Hesab və bütün açarları silinəcək, keçmiş əməliyyatları audit jurnalında adsız qalacaq. Bu geri qaytarıla bilməz.'
                : 'Bu adamın bütün aktiv açarları dərhal işləməz olacaq. Bu geri qaytarıla bilməz.'}
            </p>
            <div className="mt-2.5 flex gap-2">
              <button
                type="button"
                onClick={confirmPending}
                disabled={busy}
                className="btn-g btn-danger disabled:opacity-60"
              >
                <Trash2 className="h-4 w-4" strokeWidth={2.1} />
                {confirm.kind === 'delete' ? 'Bəli, sil' : 'Bəli, kəs'}
              </button>
              <button type="button" onClick={() => setConfirm(null)} className="btn-g">
                İmtina
              </button>
            </div>
          </div>
        )}

        {/* The one and only sighting of a key minted from this screen. */}
        {freshKey && (
          <div className="mb-4 rounded-[14px] border border-[rgba(30,140,90,.32)] bg-[rgba(30,140,90,.07)] p-3.5">
            <b className="block text-[12px] font-extrabold text-[#1c7a4f]">
              {freshKey.forWhom} üçün açar yaradıldı — indi köçürün
            </b>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink">
              Bu açar <b className="font-bold">bir daha göstərilməyəcək</b>. Verilənlər bazasında
              yalnız onun barmaq izi saxlanılır. Açarı həmin adama ötürün.
            </p>
            <div className="mt-2.5 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-[10px] border border-hair bg-[var(--g-card)] px-3 py-2 font-mono text-[12px] text-ink">
                {freshKey.token}
              </code>
              <button
                type="button"
                onClick={() => void copyFreshKey()}
                className="btn-g flex-shrink-0"
              >
                <KeyRound className="h-4 w-4" strokeWidth={2.1} />
                Kopyala
              </button>
            </div>
            <button type="button" onClick={() => setFreshKey(null)} className="btn-g mt-2.5">
              <Check className="h-4 w-4" strokeWidth={2.2} />
              Açarı köçürdüm, bağla
            </button>
          </div>
        )}

        {/* Add a person */}
        <div className="mb-4 rounded-[14px] bg-[rgba(10,16,32,.04)] p-3.5">
          {!adding ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <b className="block text-[12px] font-extrabold">Yeni adam əlavə et</b>
                <p className="mt-0.5 text-[11px] text-muted">
                  Sahə işçiləri bot və ya telefondan özləri qeydiyyatdan keçir — onları burada
                  yaratmaq lazım deyil. Bu forma supervayzer və administrator üçündür.
                </p>
              </div>
              <button type="button" onClick={() => setAdding(true)} className="btn-g btn-g-primary">
                <UserPlus className="h-4 w-4" strokeWidth={2.1} />
                Əlavə et
              </button>
            </div>
          ) : (
            <div>
              <b className="mb-2 block text-[12px] font-extrabold">Yeni adam</b>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-[.06em] text-muted">
                    Ad və soyad *
                  </span>
                  <input
                    value={draft.fullName}
                    onChange={(event) => setDraft({ ...draft, fullName: event.target.value })}
                    placeholder="Məsələn: Aysel Hüseynova"
                    className="w-full rounded-[11px] border border-hair bg-[var(--g-card)] px-3 py-2 text-[12.5px] text-ink outline-none"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-[.06em] text-muted">
                    E-poçt (vacib deyil)
                  </span>
                  <input
                    value={draft.email}
                    onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                    placeholder="aysel@coke.oneteam.az"
                    className="w-full rounded-[11px] border border-hair bg-[var(--g-card)] px-3 py-2 text-[12.5px] text-ink outline-none"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-[.06em] text-muted">
                    Telefon (vacib deyil)
                  </span>
                  <input
                    value={draft.phone}
                    onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
                    placeholder="+99450..."
                    className="w-full rounded-[11px] border border-hair bg-[var(--g-card)] px-3 py-2 text-[12.5px] text-ink outline-none"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-[.06em] text-muted">
                    Rol
                  </span>
                  <select
                    value={draft.role}
                    onChange={(event) => setDraft({ ...draft, role: event.target.value })}
                    className="w-full rounded-[11px] border border-hair bg-[var(--g-card)] px-3 py-2 text-[12.5px] text-ink outline-none"
                  >
                    {roles.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABEL[role] ?? role}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {ROLE_HELP[draft.role] && (
                <p className="mt-2 text-[11px] text-muted">{ROLE_HELP[draft.role]}</p>
              )}
              <div className="mt-2.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={busy}
                  className="btn-g btn-g-primary disabled:opacity-60"
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.1} />
                  ) : (
                    <UserPlus className="h-4 w-4" strokeWidth={2.1} />
                  )}
                  Yarat
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setDraft(EMPTY_DRAFT);
                  }}
                  className="btn-g"
                >
                  İmtina
                </button>
              </div>
            </div>
          )}
        </div>

        {/* The list */}
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="text-[12px] font-extrabold tracking-[-.02em]">
            İstifadəçilər ({users.length})
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

        {loading && users.length === 0 ? (
          <p className="rounded-[12px] bg-[rgba(10,16,32,.04)] p-3 text-[11.5px] text-muted">
            Yüklənir…
          </p>
        ) : (
          <div className="space-y-2">
            {users.map((user) => (
              <div
                key={user.id}
                className="rounded-[12px] border border-hair bg-[var(--g-card)] p-3"
              >
                {editing === user.id ? (
                  <div>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <input
                        value={editDraft.fullName}
                        onChange={(event) =>
                          setEditDraft({ ...editDraft, fullName: event.target.value })
                        }
                        className="rounded-[10px] border border-hair bg-[var(--g-card)] px-2.5 py-1.5 text-[12px] text-ink outline-none"
                      />
                      <select
                        value={editDraft.role}
                        onChange={(event) =>
                          setEditDraft({ ...editDraft, role: event.target.value })
                        }
                        disabled={user.isSelf}
                        title={user.isSelf ? 'Öz rolunuzu özünüz dəyişə bilməzsiniz' : 'Rolu dəyiş'}
                        className="rounded-[10px] border border-hair bg-[var(--g-card)] px-2.5 py-1.5 text-[12px] text-ink outline-none disabled:opacity-50"
                      >
                        {roles.map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABEL[role] ?? role}
                          </option>
                        ))}
                      </select>
                      <input
                        value={editDraft.phone}
                        onChange={(event) =>
                          setEditDraft({ ...editDraft, phone: event.target.value })
                        }
                        placeholder="Telefon"
                        className="rounded-[10px] border border-hair bg-[var(--g-card)] px-2.5 py-1.5 text-[12px] text-ink outline-none"
                      />
                    </div>
                    {ROLE_HELP[editDraft.role] && (
                      <p className="mt-1.5 text-[10.5px] text-muted">{ROLE_HELP[editDraft.role]}</p>
                    )}
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void handleSaveEdit(user)}
                        disabled={busy}
                        className="btn-g btn-g-primary disabled:opacity-60"
                      >
                        <Check className="h-3.5 w-3.5" strokeWidth={2.2} />
                        Yadda saxla
                      </button>
                      <button type="button" onClick={() => setEditing(null)} className="btn-g">
                        İmtina
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <b className="text-[12.5px] font-extrabold">{user.fullName}</b>
                        <span className="rounded-full bg-[rgba(10,16,32,.07)] px-2 py-0.5 text-[10px] font-bold text-ink">
                          {ROLE_LABEL[user.role] ?? user.role}
                        </span>
                        {user.isSelf && (
                          <span className="rounded-full bg-[rgba(30,140,90,.14)] px-2 py-0.5 text-[10px] font-bold text-[#1c7a4f]">
                            siz
                          </span>
                        )}
                        {user.joinedVia && (
                          <span className="rounded-full bg-[rgba(10,16,32,.05)] px-2 py-0.5 text-[10px] text-muted">
                            {user.joinedVia === 'telegram'
                              ? 'Telegram ilə qoşulub'
                              : 'Telefon ilə qoşulub'}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[10.5px] text-muted">
                        {user.email ?? 'E-poçt yoxdur'}
                        {user.phone ? ` · ${user.phone}` : ''}
                        {` · ${user.liveKeys} aktiv açar`}
                        {user.submissions !== null ? ` · ${user.submissions} təqdimat` : ''}
                      </p>
                      {!user.deletable && user.blockedBy && (
                        <p className="mt-0.5 text-[10.5px] text-[#b23b3b]">
                          {BLOCK_REASON[user.blockedBy]}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-shrink-0 flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => void handleMint(user)}
                        disabled={busy}
                        className="btn-g disabled:opacity-50"
                        title="Bu adam üçün yeni panel girişi açarı yarat"
                      >
                        <KeyRound className="h-3.5 w-3.5" strokeWidth={2.1} />
                        Açar yarat
                      </button>
                      {user.liveKeys > 0 && (
                        <button
                          type="button"
                          onClick={() => setConfirm({ kind: 'revoke', user })}
                          disabled={busy || user.isSelf}
                          className="btn-g disabled:opacity-40"
                          title={
                            user.isSelf
                              ? 'Öz açarlarınızı buradan ləğv edə bilməzsiniz'
                              : 'Bütün açarlarını ləğv et'
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={2.1} />
                          Açarları kəs
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => startEditing(user)}
                        disabled={busy}
                        className="btn-g disabled:opacity-50"
                        title="Adı, rolu və ya telefonu dəyiş"
                      >
                        <Pencil className="h-3.5 w-3.5" strokeWidth={2.1} />
                        Düzəlt
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirm({ kind: 'delete', user })}
                        disabled={busy || !user.deletable}
                        className="btn-g disabled:opacity-40"
                        title={
                          user.deletable
                            ? 'Hesabı sil'
                            : user.blockedBy
                              ? BLOCK_REASON[user.blockedBy]
                              : ''
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={2.1} />
                        Sil
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <p className="mt-3 text-[10.5px] leading-relaxed text-muted">
          Hesab silindikdə onun bütün açarları da silinir və keçmiş əməliyyatları audit jurnalında
          adsız qalır. Audit təqdimatı olan şəxs silinmir — ona görə də silmək əvəzinə açarlarını
          kəsmək tövsiyə olunur.
        </p>
      </div>
    </div>
  );
};
