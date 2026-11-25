/**
 * oneTeam — şüşə dizayn köçürmə skripti
 * AuditReviewCenter.tsx və TaskManager.tsx üzərində sistemli sinif əvəzləməsi.
 * Sıra vacibdir: daha spesifik nümunələr əvvəl işlənməlidir.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/macbookair/GitHub/oneTeam/web/src/components';
const FILES = ['AuditReviewCenter.tsx', 'TaskManager.tsx'];

/** [axtarış, əvəz] — sıra qorunur */
const RULES = [
  // ── 0. Əvvəlcə "tələ" olan siniflər (sonrakı qaydalar onları poza bilər) ──
  ['placeholder-slate-400', 'placeholder:text-faint'],

  // ── 1. Modal pərdəsi ──────────────────────────────────────────────────────
  ['fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm', 'fixed inset-0 z-50 modal-veil'],
  ['fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm', 'fixed inset-0 z-50 modal-veil'],
  ['fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs', 'fixed inset-0 z-50 modal-veil'],
  ['fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs', 'fixed inset-0 z-50 modal-veil'],

  // ── 2. Modal panelləri ────────────────────────────────────────────────────
  [
    'bg-white w-full max-w-5xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden',
    'glass-pop w-full max-w-5xl rounded-card overflow-hidden',
  ],
  [
    'bg-white w-full max-w-2xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden',
    'glass-pop w-full max-w-2xl rounded-card overflow-hidden',
  ],
  [
    'bg-white w-full max-w-xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden',
    'glass-pop w-full max-w-xl rounded-card overflow-hidden',
  ],
  ['rounded-2xl shadow-2xl border border-slate-200', 'rounded-card'],

  // ── 3. Ağ kart konteynerləri ──────────────────────────────────────────────
  [
    'bg-white rounded-xl p-4 border border-slate-200 shadow-subtle',
    'glass-card rounded-card p-4',
  ],
  [
    'bg-white rounded-xl border border-slate-200 shadow-subtle',
    'glass-card rounded-card',
  ],
  ['bg-white rounded-xl border border-slate-200', 'glass-card rounded-card'],

  // ── 4. Düymələr ───────────────────────────────────────────────────────────
  ['bg-slate-900 hover:bg-slate-800', 'btn-strong'],
  ['bg-brand-500 hover:bg-brand-600', 'btn-brand'],
  ['bg-rose-600 hover:bg-rose-700', 'btn-danger'],
  ['bg-emerald-600 hover:bg-emerald-700', 'btn-ok'],

  // ── 5. Köhnəlmiş / mövcud olmayan siniflər ────────────────────────────────
  ['shadow-xs ', ''],
  [' shadow-xs', ''],
  ['backdrop-blur-xs', 'backdrop-blur-sm'],

  // ── 6. Səth rəngləri ──────────────────────────────────────────────────────
  ['bg-slate-100/60', 'bg-[var(--g-panel)]'],
  ['bg-slate-200/80 hover:bg-slate-300', 'bg-[var(--g-panel)] hover:bg-[var(--g-card)]'],
  ['bg-slate-50', 'bg-[var(--g-panel)]'],
  ['bg-slate-100', 'bg-[var(--g-panel)]'],
  ['hover:bg-slate-200', 'hover:bg-[var(--g-card)]'],
  ['hover:bg-slate-100', 'hover:bg-[var(--g-card)]'],
  ['hover:bg-slate-50', 'hover:bg-[var(--g-card)]'],
  ['hover:bg-white', 'hover:bg-[var(--g-card)]'],
  ['bg-white', 'bg-[var(--g-card)]'],

  // ── 7. Kənarlar ───────────────────────────────────────────────────────────
  ['border-slate-300', 'border-hair'],
  ['border-slate-200', 'border-hair'],
  ['border-slate-100', 'border-hair-2'],
  ['divide-slate-100', 'divide-[var(--hair-2)]'],

  // ── 8. Mətn rəngləri (ən sonda — qısa adlar uzunları poza bilər) ──────────
  ['text-slate-900', 'text-ink'],
  ['text-slate-800', 'text-ink'],
  ['text-slate-700', 'text-ink-2'],
  ['text-slate-600', 'text-ink-2'],
  ['text-slate-500', 'text-muted'],
  ['text-slate-400', 'text-faint'],
  ['text-slate-300', 'text-faint'],

  // ── 9. Fokus halqası ──────────────────────────────────────────────────────
  ['focus:ring-brand-500/20 focus:border-brand-500', 'focus:ring-[var(--brand-ring)] focus:border-brand/45'],

  // ── 10. Hover aksent ──────────────────────────────────────────────────────
  ['hover:bg-brand-500 hover:text-white', 'hover:bg-[var(--brand-soft)] hover:text-brand'],
];

let grandTotal = 0;

for (const file of FILES) {
  const full = path.join(ROOT, file);
  let src = fs.readFileSync(full, 'utf8');
  const before = src;
  const report = [];

  for (const [from, to] of RULES) {
    const parts = src.split(from);
    const hits = parts.length - 1;
    if (hits > 0) {
      src = parts.join(to);
      report.push(`  ${String(hits).padStart(3)}×  ${from}  →  ${to || '(silindi)'}`);
      grandTotal += hits;
    }
  }

  // Artıq boşluqları təmizlə (yalnız className sətirləri daxilində)
  src = src.replace(/className="([^"]*)"/g, (_m, cls) =>
    `className="${cls.replace(/\s{2,}/g, ' ').trim()}"`
  );

  if (src !== before) {
    fs.writeFileSync(full, src, 'utf8');
    console.log(`\n═══ ${file} ═══`);
    console.log(report.join('\n'));
  } else {
    console.log(`\n═══ ${file} — dəyişiklik yoxdur ═══`);
  }
}

console.log(`\nÜmumi əvəzləmə: ${grandTotal}`);
