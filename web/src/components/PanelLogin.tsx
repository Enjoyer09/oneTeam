/**
 * oneTeam Supervisor Portal — sign-in screen
 * ============================================================================
 *
 * Shown when the API says the panel requires a key and the browser has not got
 * one that works. It is deliberately the whole screen: a login form rendered
 * beside a dashboard that is still loading would let someone believe they were
 * looking at data when they were looking at an empty shell.
 *
 * Signing in is: put the key where `panelAuth` can find it, then ask the API who
 * we are. There is no separate login endpoint — see panel-auth.controller.ts for
 * why. A wrong key is therefore indistinguishable from a revoked one, which is
 * the correct answer to give: both mean "sign in again".
 */
import React, { useState } from 'react';
import { KeyRound, LogIn, ShieldAlert, ShieldCheck, Loader2 } from 'lucide-react';
import { fetchIdentity, storeKey, PanelAuthError, type PanelAuthStatus } from '../lib/panelAuth';

interface PanelLoginProps {
  /** What the API said about whether a key is needed, and what is wrong if anything. */
  status: PanelAuthStatus;
  /** Called with the identity once a key is accepted. */
  onSignedIn: () => void;
}

export const PanelLogin: React.FC<PanelLoginProps> = ({ status, onSignedIn }) => {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const candidate = key.trim();
    if (!candidate) {
      setError('Açarı daxil edin.');
      return;
    }

    setBusy(true);
    setError(null);

    // Stored before the check, because the check *is* the request that carries
    // it. A failed attempt is cleaned up below rather than left behind.
    storeKey(candidate);
    try {
      await fetchIdentity();
      onSignedIn();
    } catch (caught) {
      const message =
        caught instanceof PanelAuthError && caught.status === 401
          ? 'Bu açar qəbul edilmədi. Yadda saxlayın ki, açar yalnız yaradıldığı anda göstərilir — ' +
            'itirilibsə, administrator yenisini yaratmalıdır.'
          : caught instanceof Error
            ? caught.message
            : String(caught);
      setError(message);
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-page px-4 text-ink">
      <div className="relative z-10 w-full max-w-[420px]">
        {/* `submit` is async and calls `preventDefault` itself, so the event has
            to be forwarded; `void` only detaches the promise React ignores. */}
        <form
          onSubmit={(event) => void submit(event)}
          className="glass-card rounded-card p-6 sm:p-7"
        >
          <div className="mb-5 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--primary-soft)]">
              <KeyRound className="h-[18px] w-[18px] text-primary" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <h1 className="text-[17px] font-extrabold tracking-[-.03em] leading-tight">
                oneTeam Supervayzer Paneli
              </h1>
              <p className="mt-0.5 text-[13px] text-muted">
                Davam etmək üçün şəxsi giriş açarınızı daxil edin
              </p>
            </div>
          </div>

          {/* A configured bootstrap key that is being refused. Shown above the
              form because nothing typed here will work until it is fixed. */}
          {status.bootstrapProblem && (
            <div className="mb-4 flex gap-2.5 rounded-[12px] border border-[var(--bad-bd)] bg-[var(--bad-bg)] p-3">
              <ShieldAlert
                className="mt-px h-4 w-4 flex-shrink-0 text-[var(--bad)]"
                strokeWidth={2}
              />
              <div className="text-[13.5px] leading-relaxed">
                <b className="block font-bold text-[var(--bad)]">Bootstrap açarı qəbul edilmir</b>
                <span className="text-ink">{status.bootstrapProblem}</span>
              </div>
            </div>
          )}

          <label
            htmlFor="panel-key"
            className="mb-1.5 block text-[13px] font-bold uppercase tracking-[.06em] text-muted"
          >
            Giriş açarı
          </label>
          <input
            id="panel-key"
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="otp_..."
            className="w-full rounded-[12px] border border-hair bg-[var(--modal-field)]
                       px-3 py-2.5 font-mono text-[15px] text-ink outline-none
                       focus:border-primary-500/45 focus:ring-2 focus:ring-[var(--primary-ring)]"
          />

          {error && (
            <p className="mt-3 text-[13.5px] leading-relaxed text-[var(--bad)]" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="btn-g btn-g-primary mt-4 w-full justify-center disabled:opacity-60"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.1} />
            ) : (
              <LogIn className="h-4 w-4" strokeWidth={2.1} />
            )}
            {busy ? 'Yoxlanılır...' : 'Daxil ol'}
          </button>

          {/* The first-run path, said in full. The operator should not have to
              work out why nothing they type is accepted. */}
          {!status.bootstrapProblem && status.liveKeys === 0 && status.bootstrapConfigured && (
            <div className="mt-4 flex gap-2.5 rounded-[12px] bg-[var(--g-panel)] p-3">
              <ShieldCheck className="mt-px h-4 w-4 flex-shrink-0 text-muted" strokeWidth={2} />
              <p className="text-[13.5px] leading-relaxed text-muted">
                Hələ şəxsi açar yaradılmayıb. <b className="font-bold text-ink">Bootstrap açarı</b>{' '}
                ilə daxil olun, sonra «Giriş açarları» bölməsindən özünüzə şəxsi açar yaradın və
                bootstrap açarını serverdən silin.
              </p>
            </div>
          )}
        </form>

        <p className="mt-3 px-1 text-center text-[13px] leading-relaxed text-muted">
          {status.detail}
        </p>
      </div>
    </div>
  );
};
