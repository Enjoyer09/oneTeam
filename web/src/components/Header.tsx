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
  onOpenCreateTask: () => void;
  /** Telefon ölçüsündə çekmeceni açır */
  onOpenDrawer?: () => void;
  /** Məzmun sürüşdürülübsə toolbar bir az qatılaşır — "üzən" hissi */
  scrolled?: boolean;
  /**
   * Who the API says is calling, or null when it could not be asked.
   *
   * `via: 'service'` means nobody signed in and the edge supplied a credential —
   * the open-panel state. That distinction is shown rather than hidden: a person
   * approving audits should be able to see whether the system knows who they
   * are.
   */
  identity: PanelIdentity | null;
  onSignOut: () => void;
  onOpenKeys: () => void;
  /** People and roles — administrator only, next to the key button. */
  onOpenUsers: () => void;
}

const THEME_KEY = 'oneteam-theme';

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Administrator',
  SUPERVISOR: 'Supervayzer',
  MERCHANDISER: 'Merchandiser',
};

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  onOpenCreateTask,
  onOpenDrawer,
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
      const now = new Date();
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

  const titles: Record<TabType, { title: string; subtitle: string }> = {
    dashboard: {
      title: 'İcmal & Əsas Göstəricilər',
      subtitle: 'Real-vaxt rəf monitorinqi və mağaza uyğunluq statistikası',
    },
    review: {
      title: 'Rəf Auditi & Yoxlama Mərkəzi',
      subtitle: 'Sahədən göndərilən rəf fotolarının planogramla müqayisəsi və təsdiqi',
    },
    tasks: {
      title: 'Planogram & Təlimat İdarəetməsi',
      subtitle: 'Mağazalara göndərilən rəf düzülüş standartları və tapşırıqlar',
    },
    stores: {
      title: 'Tərəfdaş Mağazalar Şəbəkəsi',
      subtitle: 'Bravo, Araz, Bazarstore filialları və uyğunluq göstəriciləri',
    },
    products: {
      title: 'Məhsul Kataloqu (SKU)',
      subtitle: 'Skanerilən barkodun həll etdiyi məhsul identiteti',
    },
    shelfmap: {
      title: 'Rəf Xəritəsi',
      subtitle: 'Bölmə / səviyyə / mövqe — planogram müqayisəsinin bazası',
    },
  };

  const { title, subtitle } = titles[activeTab];

  /** A signed-in person, as opposed to the credential the edge supplied. */
  const signedIn = identity !== null && identity.via === 'panel';

  return (
    <header
      className={[
        'relative z-20 flex items-center gap-3 flex-shrink-0 h-[60px] px-3 sm:px-4 lg:px-5',
        'glass-chrome border-x-0 border-t-0',
        'transition-shadow duration-250 ease-out',
        scrolled ? 'shadow-[0_6px_20px_-14px_rgba(10,16,32,.45)]' : '',
      ].join(' ')}
    >
      {/* Çekmece düyməsi — yalnız telefonda */}
      {onOpenDrawer && (
        <button
          type="button"
          onClick={onOpenDrawer}
          aria-label="Naviqasiya menyusunu aç"
          aria-controls="oneteam-sidebar"
          className="iconbtn-g md:hidden"
        >
          <Menu className="w-[18px] h-[18px]" strokeWidth={2} />
        </button>
      )}

      {/* Başlıq */}
      <div className="min-w-0 flex-1">
        <h2 className="text-[15.5px] font-extrabold tracking-[-.03em] text-ink truncate leading-tight">
          {title}
        </h2>
        <p className="hidden sm:block text-[11px] text-muted truncate mt-px">{subtitle}</p>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Kim daxil olub. Açıq panel vəziyyəti burada da görünür — yalnız bir
            yerdə xəbərdarlıq göstərmək onu asanlıqla gözdən qaçıran edir. */}
        <div
          className="hidden md:flex items-center gap-2 h-[34px] pl-2.5 pr-3 rounded-[10px] glass-panel"
          title={
            signedIn ? 'Şəxsi açarınızla daxil olmusunuz' : 'Heç kim daxil olmayıb — panel açıqdır'
          }
        >
          {signedIn ? (
            <KeyRound className="w-3.5 h-3.5 text-muted" strokeWidth={1.9} />
          ) : (
            <ShieldAlert className="w-3.5 h-3.5 text-[#b23b3b]" strokeWidth={1.9} />
          )}
          <div className="min-w-0 leading-tight">
            <span className="block max-w-[190px] truncate text-[11.5px] font-bold text-ink">
              {identity?.fullName ?? 'Kimlik bilinmir'}
            </span>
            <span className="block text-[11px] text-muted">
              {signedIn
                ? (ROLE_LABEL[identity?.role ?? ''] ?? identity?.role ?? '')
                : 'Açıq panel — giriş yoxdur'}
            </span>
          </div>
        </div>

        {/* Açar idarəetməsi — yalnız administratora. Açıq vəziyyətdə də
            göstərilir, çünki ilk açarı yaradan məhz bu düymədir. */}
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

        {/* İstifadəçilər — açar düyməsinin yanında, çünki ikisi bir qərarın iki
            yarısıdır: əvvəl adamı yaradırsan, sonra ona açar verirsən. */}
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

        {/* Çıxış — yalnız şəxsi açarla daxil olubsa. Açıq vəziyyətdə çıxılacaq
            bir şey yoxdur, və düymə göstərmək "daxil olmusunuz" təəssüratı verər. */}
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

        {/* Bakı saatı */}
        <div
          className="hidden lg:flex items-center gap-1.5 h-[34px] px-3 rounded-[10px] glass-panel text-[11.5px] text-muted"
          title="Bakı vaxtı ilə cari saat"
        >
          <Clock className="w-3.5 h-3.5 text-muted" strokeWidth={1.9} />
          <span className="hidden xl:inline">Bakı:</span>
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

        {/* Əsas əməliyyat */}
        <button
          type="button"
          onClick={onOpenCreateTask}
          className="btn-g btn-g-primary"
          title="Yeni planogram təlimatı yarat"
        >
          <PlusCircle className="w-4 h-4" strokeWidth={2.1} />
          <span className="hidden sm:inline">Yeni Təlimat Yarat</span>
          <span className="sr-only sm:hidden">Yeni Təlimat Yarat</span>
        </button>
      </div>
    </header>
  );
};
