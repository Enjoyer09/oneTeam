import { clock } from '../lib/clock';
import React, { useState, useEffect } from 'react';
import {
  PlusCircle,
  Clock,
  Menu,
  Sun,
  Moon,
  KeyRound,
  LogOut,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { TabType } from './Sidebar';
import type { PanelIdentity } from '../lib/panelAuth';

interface HeaderProps {
  activeTab: TabType;
  onNavigate: (tab: TabType) => void;
  pendingCount: number;
  onOpenCreateTask: () => void;
  /** Telefon ölçüsündə çekmeceni açır */
  onOpenDrawer?: () => void;
  drawerOpen?: boolean;
  /** Məzmun sürüşdürülübsə toolbar bir az qatılaşır */
  scrolled?: boolean;
  /**
   * Who the API says is calling, or null when it could not be asked.
   * `via: 'service'` means nobody signed in and the edge supplied a credential —
   * the open-panel state, shown rather than hidden.
   */
  identity: PanelIdentity | null;
  onSignOut: () => void;
  onOpenKeys: () => void;
  onOpenUsers: () => void;
}

const THEME_KEY = 'oneteam-theme';

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Administrator',
  SUPERVISOR: 'Supervayzer',
  MERCHANDISER: 'Merchandiser',
};

/* Üst pill naviqasiya — qısa etiketlər. Mobil çekmece (Sidebar) tam adları
   saxlayır; buradakı aria-label App testlərinin kliklədiyi adlarla eynidir. */
const NAV_ITEMS: { id: TabType; label: string }[] = [
  { id: 'dashboard', label: 'İcmal' },
  { id: 'review', label: 'Auditlər' },
  { id: 'tasks', label: 'Tapşırıqlar' },
  { id: 'stores', label: 'Mağazalar' },
  { id: 'products', label: 'Məhsullar' },
  { id: 'shelfmap', label: 'Rəf planı' },
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((w) => w[0]?.toUpperCase() ?? '').join('');
  return letters || '?';
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  onNavigate,
  pendingCount,
  onOpenCreateTask,
  onOpenDrawer,
  drawerOpen = false,
  scrolled = false,
  identity,
  onSignOut,
  onOpenKeys,
  onOpenUsers,
}) => {
  const [timeStr, setTimeStr] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof document === 'undefined') return 'light';
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  });

  useEffect(() => {
    const updateTime = () => {
      const now = clock.now();
      setTimeStr(
        now.toLocaleTimeString('az-AZ', {
          timeZone: 'Asia/Baku',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* localStorage əlçatan deyilsə, sadəcə sessiya üçün dəyişir */
    }
  };

  const signedIn = identity !== null && identity.via === 'panel';

  return (
    <header
      className={[
        'glass-chrome relative z-20 flex items-center gap-3 flex-shrink-0 h-[68px] px-3 sm:px-5 lg:px-6',
        'transition-shadow duration-250 ease-out',
        scrolled ? 'shadow-[0_6px_20px_-14px_rgba(23,27,46,.28)]' : '',
      ].join(' ')}
    >
      {/* Çekmece düyməsi — yalnız telefonda */}
      {onOpenDrawer && (
        <button
          type="button"
          onClick={onOpenDrawer}
          aria-label="Naviqasiya menyusunu aç"
          aria-controls="oneteam-sidebar"
          aria-expanded={drawerOpen}
          className="iconbtn-g md:hidden"
        >
          <Menu className="w-[18px] h-[18px]" strokeWidth={2} />
        </button>
      )}

      {/* Brend */}
      <div className="flex items-center gap-2.5 flex-shrink-0">
        <div className="w-9 h-9 rounded-[12px] bg-coke flex items-center justify-center flex-shrink-0 overflow-hidden">
          <img
            src="/logo.jpg"
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLElement).style.display = 'none';
            }}
          />
        </div>
        <div className="hidden sm:flex items-center gap-1.5 leading-tight">
          <span className="font-extrabold text-[16px] tracking-[-.03em] text-ink">oneTeam</span>
          <span className="text-[9px] uppercase font-extrabold tracking-[.07em] px-1.5 py-[2px] rounded-md bg-coke/10 text-coke border border-coke/25">
            Coca-Cola
          </span>
        </div>
      </div>

      {/* Mərkəzi pill naviqasiya */}
      <nav className="hidden md:flex flex-1 justify-center min-w-0" aria-label="Əsas naviqasiya">
        <div className="seg max-w-full overflow-x-auto">
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            const badge = item.id === 'review' && pendingCount > 0 ? pendingCount : null;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                aria-label={item.label}
                aria-current={isActive ? 'page' : undefined}
                className="seg-item"
              >
                {item.label}
                {badge !== null && (
                  <span
                    className="text-[10px] px-1.5 py-[1px] rounded-full font-extrabold border text-warn"
                    style={{ backgroundColor: 'var(--warn-bg)', borderColor: 'var(--warn-bd)' }}
                  >
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Sağ əməliyyatlar */}
      <div className="flex items-center gap-1.5 flex-shrink-0 ml-auto md:ml-0">
        {/* Bakı saatı */}
        <div
          className="hidden xl:flex items-center gap-1.5 h-[36px] px-3 rounded-[12px] glass-panel text-[11.5px] text-muted"
          title="Bakı vaxtı ilə cari saat"
        >
          <Clock className="w-3.5 h-3.5 text-muted" strokeWidth={1.9} />
          <span className="font-mono font-bold text-ink tabular-nums">{timeStr || '--:--:--'}</span>
        </div>

        {/* Tema keçidi */}
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'İşıq temasına keç' : 'Tünd temasına keç'}
          title={theme === 'dark' ? 'İşıq teması' : 'Tünd tema'}
          className="iconbtn-g"
        >
          {theme === 'dark' ? (
            <Sun className="w-[17px] h-[17px]" strokeWidth={1.9} />
          ) : (
            <Moon className="w-[17px] h-[17px]" strokeWidth={1.9} />
          )}
        </button>

        {identity?.canManageKeys && (
          <button
            type="button"
            onClick={onOpenKeys}
            className="iconbtn-g"
            aria-label="Panel giriş açarları"
            title="Panel giriş açarları"
          >
            <KeyRound className="w-[17px] h-[17px]" strokeWidth={1.9} />
          </button>
        )}
        {identity?.canManageKeys && (
          <button
            type="button"
            onClick={onOpenUsers}
            className="iconbtn-g"
            aria-label="İstifadəçilər və rollar"
            title="İstifadəçilər və rollar"
          >
            <Users className="w-[17px] h-[17px]" strokeWidth={1.9} />
          </button>
        )}

        {/* Kim daxil olub — açıq panel vəziyyəti də görünür */}
        <div
          className="hidden lg:flex items-center gap-2 h-[40px] pl-1.5 pr-3 rounded-full glass-card"
          title={
            signedIn ? 'Şəxsi açarınızla daxil olmusunuz' : 'Heç kim daxil olmayıb — panel açıqdır'
          }
        >
          <span
            className="grid w-7 h-7 place-items-center rounded-full bg-primary-500/15 text-primary font-extrabold text-[10px] flex-shrink-0"
            aria-hidden="true"
          >
            {signedIn && identity?.fullName ? (
              initialsOf(identity.fullName)
            ) : (
              <ShieldAlert className="w-3.5 h-3.5 text-warn" strokeWidth={2} />
            )}
          </span>
          <span className="min-w-0 leading-tight">
            <span className="block max-w-[150px] truncate text-[11.5px] font-bold text-ink">
              {identity?.fullName ?? 'Kimlik bilinmir'}
            </span>
            <span className="block text-[10px] text-muted truncate">
              {signedIn
                ? (ROLE_LABEL[identity?.role ?? ''] ?? identity?.role ?? '')
                : 'Açıq panel — giriş yoxdur'}
            </span>
          </span>
        </div>

        {signedIn && (
          <button
            type="button"
            onClick={onSignOut}
            className="iconbtn-g"
            aria-label="Çıxış"
            title="Çıxış"
          >
            <LogOut className="w-[17px] h-[17px]" strokeWidth={1.9} />
          </button>
        )}

        {/* Əsas əməliyyat */}
        <button
          type="button"
          onClick={onOpenCreateTask}
          className="btn-g btn-g-primary"
          title="Yeni planogram təlimatı yarat"
        >
          <PlusCircle className="w-4 h-4" strokeWidth={2.1} />
          <span className="hidden sm:inline">Yeni Təlimat</span>
          <span className="sr-only sm:hidden">Yeni Təlimat Yarat</span>
        </button>
      </div>
    </header>
  );
};