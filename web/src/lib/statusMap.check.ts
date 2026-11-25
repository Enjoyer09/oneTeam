/**
 * DESIGN §11 (canonical status → visual mapping) üçün assert-check.
 * Qayda: "If a component disagrees with the component is wrong."
 *
 * İcra: node ./node_modules/tsx/dist/cli.mjs web/src/lib/statusMap.check.ts
 */
import { statusChip, STATUS_VALUES } from './statusMap';

let n = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    return;
  }
  n += 1;
}

// §11 cədvəlinin hər sətri — dəyər, rəng ailəsi, emoji, Azərbaycanca etiket.
const CANONICAL: Array<[string, string, string, string]> = [
  ['approved', 'emerald', '✅', 'Təsdiqləndi'],
  ['pending_review', 'amber', '⏳', 'Gözləyir'],
  ['rejected', 'rose', '❌', 'İmtina edildi'],
  ['urgent', 'rose', '🔴', 'Təcili'],
  ['high', 'orange', '🟠', 'Yüksək'],
  ['medium', 'amber', '🟡', 'Orta'],
  ['low', 'emerald', '🟢', 'Aşağı'],
  ['draft', 'slate', '—', 'Qaralama'],
  ['published', 'emerald', '—', 'Aktiv'],
  ['completed', 'slate', '—', 'Tamamlandı'],
  ['archived', 'slate', '—', 'Arxivlənmiş'],
  ['scenario_a_compliant', 'emerald', '⭐', 'Ssenari A'],
  ['scenario_b_gap', 'amber', '⚠️', 'Ssenari B'],
  ['scenario_c_missing_sku', 'rose', '❌', 'Ssenari C'],
];

for (const [value, family, emoji, label] of CANONICAL) {
  const chip = statusChip(value);
  ok(chip.family === family, `${value}: family ${chip.family} ≠ ${family}`);
  ok(chip.emoji === emoji, `${value}: emoji ${chip.emoji} ≠ ${emoji}`);
  ok(chip.label === label, `${value}: label "${chip.label}" ≠ "${label}"`);
  ok(
    chip.classes.includes(`text-${family}-700`) && chip.classes.includes(`bg-${family}-50`),
    `${value}: §10.4 table/card şəkli yoxdur → ${chip.classes}`,
  );
}

// statusChip fallback: naməlum dəyər neutral etiketlə qayıdır, heç vaxt crash yox.
const unknown = statusChip('definitely_not_a_status');
ok(unknown.family === 'slate', 'unknown: neutral slate olmalıdır');
ok(unknown.label === 'definitely_not_a_status', 'unknown: xam dəyər etiket kimi qalmalıdır');

ok(STATUS_VALUES.length === CANONICAL.length, 'STATUS_VALUES sayı §11 sətri sayıdır');

console.log(`✓ statusMap: ${n} checks`);
