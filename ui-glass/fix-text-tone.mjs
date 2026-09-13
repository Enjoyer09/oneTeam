/**
 * Mətn tonu düzəlişi.
 *
 * Tapıntı: --faint (#8d9ab0) ağ şüşə üzərində 2.68:1 təzad verir — WCAG AA
 * həddi 4.5:1. Dizaynın üç pilləli boz iyerarxiyası işıq fonda AA ilə
 * uzlaşmır: ən açıq pillə fiziki olaraq oxunaqlı ola bilməz.
 *
 * Qərar: --faint yalnız DEKORATİV elementlər üçün qalır (ikon, nöqtə,
 * ayırıcı xətt). Oxunan hər mətn --muted (#5d6c86, 5.31:1) istifadə edir.
 * İyerarxiya ikon/qrafika səviyyəsində qorunur, oxunaqlıq itmir.
 */
import fs from 'node:fs';

const DIR = '/Users/macbookair/GitHub/oneTeam/web/src/components';
const FILES = [
  'Sidebar.tsx',
  'Header.tsx',
  'DashboardOverview.tsx',
  'StoreDirectory.tsx',
  'AuditReviewCenter.tsx',
  'TaskManager.tsx',
];

let total = 0;
for (const f of FILES) {
  const p = `${DIR}/${f}`;
  const src = fs.readFileSync(p, 'utf8');
  const hits = src.split('text-faint').length - 1;
  if (!hits) {
    console.log(`  ${f.padEnd(24)} dəyişiklik yoxdur`);
    continue;
  }
  fs.writeFileSync(p, src.split('text-faint').join('text-muted'), 'utf8');
  total += hits;
  console.log(`  ${f.padEnd(24)} ${hits} əvəzləmə`);
}
console.log(`\nÜmumi: ${total} mətn tonu düzəlişi`);
