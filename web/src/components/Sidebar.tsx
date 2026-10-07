import React from 'react';
import {
  LayoutDashboard,
  Camera,
  ClipboardList,
  Store as StoreIcon,
  ShieldCheck,
} from 'lucide-react';
import type { PanelIdentity } from '../lib/panelAuth';

export type TabType = 'dashboard' | 'review' | 'tasks' | 'stores';

interface SidebarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  pendingCount: number;
  /**
   * Who the API says is calling, or null when it could not be asked. The footer
   * shows this real person; when it is unknown the footer is hidden rather than
   * inventing a name.
   */
  identity?: PanelIdentity | null;
  /** Telefon ölçüsündə off-canvas çekmecenin açıq olub-olmaması */
  drawerOpen?: boolean;
  /** Çekmece bağlananda çağırılır (menyu seçimi, Escape, fon klik) */
  onCloseDrawer?: () => void;
}

/* Header-dəki eyni ad-cədvəli — rolun kodu deyil, oxunaqlı adı göstərilir. */
const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Administrator',
  SUPERVISOR: 'Supervayzer',
  MERCHANDISER: 'Merchandiser',
};

/** Ad → baş hərflər (ilk iki söz). Ad yoxdursa neytral bir işarə. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((w) => w[0]?.toUpperCase() ?? '').join('');
  return letters || '?';
}

/* Naviqasiya elementlərinin həndəsəsi — sürüşən göstərici bunlara əsaslanır.
   Dəyişsəniz, ikisini birlikdə dəyişin. */
const ITEM_H = 42;
const ITEM_GAP = 4;
const STEP = ITEM_H + ITEM_GAP;

const NAV_ITEMS: {
  id: TabType;
  label: string;
  icon: React.ElementType;
}[] = [
  { id: 'dashboard', label: 'İcmal & Statistika', icon: LayoutDashboard },
  { id: 'review', label: 'Rəf Auditi (Yoxlama)', icon: Camera },
  { id: 'tasks', label: 'Planogram Tapşırıqları', icon: ClipboardList },
  { id: 'stores', label: 'Mağazalar Şəbəkəsi', icon: StoreIcon },
];

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  pendingCount,
  identity,
  drawerOpen = false,
  onCloseDrawer,
}) => {
  const activeIndex = Math.max(
    0,
    NAV_ITEMS.findIndex((i) => i.id === activeTab),
  );

  const handleSelect = (id: TabType) => {
    setActiveTab(id);
    onCloseDrawer?.();
  };

  return (
    <aside
      id="oneteam-sidebar"
      aria-label="Əsas naviqasiya"
      className={[
        /* Telefon: ekranın üstündə açılan çekmece */
        'fixed inset-y-0 left-0 z-40 w-[252px] flex flex-col flex-shrink-0 select-none',
        'glass-side border-y-0 border-l-0',
        'transition-transform duration-250 ease-apple',
        drawerOpen ? 'translate-x-0 shadow-g3' : '-translate-x-full',
        /* Planşet: 74px ikon relsi — məzmun üçün yer açır */
        'md:static md:translate-x-0 md:w-[74px] md:shadow-none',
        /* Masaüstü: tam 252px panel */
        'xl:w-[252px]',
      ].join(' ')}
    >
      {/* ── Brend ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2.5 px-3.5 pt-4 pb-3 md:justify-center md:px-0 xl:justify-start xl:px-3.5">
        <div className="w-9 h-9 rounded-[11px] bg-coke flex items-center justify-center flex-shrink-0 overflow-hidden shadow-[0_3px_10px_-3px_var(--coke-ring)]">
          <img
            src="/logo.jpg"
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLElement).style.display = 'none';
            }}
          />
        </div>
        <div className="min-w-0 md:hidden xl:block">
          <h1 className="font-extrabold text-[14px] leading-tight tracking-[-.025em] text-ink flex items-center gap-1.5">
            oneTeam
            <span className="text-[10px] uppercase font-extrabold tracking-[.08em] px-1.5 py-[2px] rounded-md bg-coke/15 text-coke border border-coke/30">
              Coca-Cola
            </span>
          </h1>
          <p className="text-[11px] text-muted truncate mt-px">Rəf Monitorinq Portalı</p>
        </div>
      </div>

      {/* ── Naviqasiya ────────────────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto px-2.5 pb-3 md:px-2 xl:px-2.5">
        <div className="hidden px-3 pb-2 text-xs font-extrabold uppercase tracking-[.1em] text-muted md:block md:text-center md:px-0 xl:text-left xl:px-3">
          Əsas Menyu
        </div>

        <div className="relative">
          {/* Sürüşən aktiv göstərici — macOS yan panelinin imzası */}
          <span
            aria-hidden="true"
            className="glass-card absolute left-0 right-0 rounded-[11px] pointer-events-none"
            style={{
              height: ITEM_H,
              transform: `translateY(${activeIndex * STEP}px)`,
              transition: 'transform 250ms cubic-bezier(.32,.72,0,1)',
            }}
          />

          <ul className="relative m-0 list-none p-0" style={{ display: 'grid', gap: ITEM_GAP }}>
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              const badge = item.id === 'review' && pendingCount > 0 ? pendingCount : null;

              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(item.id)}
                    title={item.label}
                    aria-current={isActive ? 'page' : undefined}
                    className={[
                      'group w-full flex items-center justify-between rounded-[11px] px-3',
                      'text-[12px] font-bold tracking-[-.01em]',
                      'transition-colors duration-150',
                      'md:justify-center md:px-0 xl:justify-between xl:px-3',
                      isActive ? 'text-ink' : 'text-ink-2 hover:text-ink',
                    ].join(' ')}
                    style={{ height: ITEM_H }}
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <Icon
                        className={[
                          'w-4 h-4 flex-shrink-0 transition-colors duration-150',
                          isActive ? 'text-coke' : 'text-muted group-hover:text-ink-2',
                        ].join(' ')}
                        strokeWidth={1.9}
                      />
                      <span className="truncate md:hidden xl:inline">{item.label}</span>
                    </span>

                    {badge !== null && (
                      <span
                        className="text-[10px] px-1.5 py-[1px] rounded-full font-extrabold flex-shrink-0
                                   border text-warn
                                   md:absolute md:top-1.5 md:right-2.5 xl:static"
                        style={{
                          backgroundColor: 'var(--warn-bg)',
                          borderColor: 'var(--warn-bd)',
                        }}
                      >
                        {badge}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </nav>

      {/* ── İstifadəçi ────────────────────────────────────────────────────── */}
      {identity && (
        <div className="border-t border-hair px-2.5 py-3 md:px-2 xl:px-3.5">
          <div className="flex items-center gap-2.5 md:justify-center xl:justify-start">
            <div
              className="w-9 h-9 rounded-full glass-panel flex items-center justify-center
                         font-extrabold text-[11px] text-ink-2 flex-shrink-0"
              aria-hidden="true"
            >
              {identity.fullName ? initialsOf(identity.fullName) : '?'}
            </div>
            <div className="flex-1 min-w-0 md:hidden xl:block">
              <p className="text-[11.5px] font-bold text-ink truncate">
                {identity.fullName ?? 'Kimlik bilinmir'}
              </p>
              <p className="text-[11px] text-muted truncate flex items-center gap-1 mt-px">
                <ShieldCheck className="w-3 h-3 text-ok flex-shrink-0" />
                {ROLE_LABEL[identity.role] ?? identity.role}
              </p>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};
