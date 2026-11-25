import React, { useEffect, useLayoutEffect, useState } from 'react';
import { useModalA11y } from '../lib/useModalA11y';
import {
  LayoutDashboard,
  Camera,
  ClipboardList,
  Store as StoreIcon,
  ShieldCheck,
  Barcode,
  LayoutGrid,
  X,
} from 'lucide-react';
import type { PanelIdentity } from '../lib/panelAuth';

export type TabType = 'dashboard' | 'review' | 'tasks' | 'stores' | 'products' | 'shelfmap';

interface SidebarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  pendingCount: number;
  identity?: PanelIdentity | null;
  /** Telefon ölçüsündə off-canvas çekmacenin açıq olub-olmaması */
  drawerOpen?: boolean;
  /** Çekmece bağlananda çağırılır (menyu seçimi, Escape, fon klik) */
  onCloseDrawer?: () => void;
}

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Administrator',
  SUPERVISOR: 'Supervayzer',
  MERCHANDISER: 'Merchandiser',
};

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((w) => w[0]?.toUpperCase() ?? '').join('');
  return letters || '?';
}

const NAV_ITEMS: {
  id: TabType;
  label: string;
  icon: React.ElementType;
}[] = [
  { id: 'dashboard', label: 'İcmal & Statistika', icon: LayoutDashboard },
  { id: 'review', label: 'Rəf Auditi (Yoxlama)', icon: Camera },
  { id: 'tasks', label: 'Tapşırıqlar', icon: ClipboardList },
  { id: 'stores', label: 'Mağazalar Şəbəkəsi', icon: StoreIcon },
  { id: 'products', label: 'Məhsullar (SKU)', icon: Barcode },
  { id: 'shelfmap', label: 'Rəf Xəritəsi', icon: LayoutGrid },
];

/**
 * Mobil naviqasiya çekmecesi. Masaüstündə üst pill bar (Header) işləyir, ona
 * görə geniş ekranda bu komponent heç nə render etmir — yalnız telefon ölçüsündə
 * mövcuddur və focus-trap/inert davranışını saxlayır.
 */
export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  pendingCount,
  identity,
  drawerOpen = false,
  onCloseDrawer,
}) => {
  const [wide, setWide] = useState(() =>
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 768px)').matches
      : true,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(min-width: 768px)');
    const update = () => {
      setWide(query.matches);
      if (query.matches) onCloseDrawer?.();
    };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [onCloseDrawer]);
  const mobileOpen = !wide && drawerOpen;
  const drawerRef = useModalA11y<HTMLElement>(mobileOpen, () => onCloseDrawer?.());
  useLayoutEffect(() => {
    const node = drawerRef.current;
    const content = document.getElementById('oneteam-content');
    if (node) node.inert = !wide && !drawerOpen;
    if (content) content.inert = mobileOpen;
    return () => {
      if (node) node.inert = false;
      if (content) content.inert = false;
    };
  }, [wide, drawerOpen, mobileOpen, drawerRef]);

  const handleSelect = (id: TabType) => {
    setActiveTab(id);
    onCloseDrawer?.();
  };

  if (wide) return null;

  return (
    <aside
      id="oneteam-sidebar"
      ref={drawerRef}
      role={mobileOpen ? 'dialog' : undefined}
      aria-modal={mobileOpen ? true : undefined}
      aria-hidden={!drawerOpen ? true : undefined}
      aria-label="Əsas naviqasiya"
      className={[
        'fixed inset-y-0 left-0 z-40 w-[280px] flex flex-col flex-shrink-0 select-none',
        'glass-side border-y-0 border-l-0 shadow-g3',
        'transition-transform duration-250 ease-apple',
        drawerOpen ? 'translate-x-0' : '-translate-x-full invisible',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-[12px] bg-brand flex items-center justify-center flex-shrink-0 overflow-hidden">
            <img
              src="/logo.jpg"
              alt=""
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.target as HTMLElement).style.display = 'none';
              }}
            />
          </div>
          <div className="min-w-0 leading-tight">
            <span className="font-extrabold text-[17px] tracking-[-.03em] text-ink">oneTeam</span>
            <p className="text-[12.5px] text-muted truncate">Rəf Monitorinq Portalı</p>
          </div>
        </div>
        <button
          type="button"
          className="btn-g min-h-[40px] px-3"
          onClick={onCloseDrawer}
          aria-label="Menyunu bağla"
        >
          <X className="w-4 h-4" strokeWidth={2.2} />
          <span className="text-[14px]">Bağla</span>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-3">
        <div className="px-2 pb-2 text-[12.5px] font-extrabold uppercase tracking-[.1em] text-muted">
          Əsas Menyu
        </div>
        <ul className="m-0 list-none p-0 grid gap-1">
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
                  aria-label={item.label}
                  aria-current={isActive ? 'page' : undefined}
                  className={[
                    'group w-full flex items-center justify-between gap-2 rounded-[12px] px-3 h-[44px]',
                    'text-[15px] font-bold tracking-[-.01em] transition-colors duration-150',
                    isActive
                      ? 'bg-primary-500/12 text-primary'
                      : 'text-ink-2 hover:bg-[var(--g-panel)] hover:text-ink',
                  ].join(' ')}
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <Icon
                      className={[
                        'w-4 h-4 flex-shrink-0',
                        isActive ? 'text-primary' : 'text-muted group-hover:text-ink-2',
                      ].join(' ')}
                      strokeWidth={1.9}
                    />
                    <span className="truncate">{item.label}</span>
                  </span>
                  {badge !== null && (
                    <span
                      className="text-[12px] px-1.5 py-[1px] rounded-full font-extrabold flex-shrink-0 border text-warn"
                      style={{ backgroundColor: 'var(--warn-bg)', borderColor: 'var(--warn-bd)' }}
                    >
                      {badge}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {identity && (
        <div className="border-t border-hair px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div
              className="w-9 h-9 rounded-full bg-primary-500/15 flex items-center justify-center font-extrabold text-[13px] text-primary flex-shrink-0"
              aria-hidden="true"
            >
              {identity.fullName ? initialsOf(identity.fullName) : '?'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[14px] font-bold text-ink truncate">
                {identity.fullName ?? 'Kimlik bilinmir'}
              </p>
              <p className="text-[13px] text-muted truncate flex items-center gap-1 mt-px">
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
