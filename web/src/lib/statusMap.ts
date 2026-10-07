/**
 * DESIGN §11 — canonical status → visual mapping (rəng ailəsi + emoji + etiket)
 * və §10.4 — status badge şəkli (table/card density).
 *
 * XƏTT: "If a component disagrees with it, the component is wrong."
 * Ona görə ailə/etiket məlumatı burada — yeddi komponentdə yox — saxlanılır.
 * Yoxlama: statusMap.check.ts (RED/GREEN, §11 cədvəlinin hər sətri).
 */

/** §10.4 table/card density — hamı üçün vahid şəkil. */
export const STATUS_CHIP_SHAPE =
  'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold';

export interface StatusChip {
  family: string;
  emoji: string;
  label: string;
  /** Shape + family rəngləri — tam className stringi. */
  classes: string;
}

const MAP: Record<string, { family: string; emoji: string; label: string }> = {
  approved: { family: 'emerald', emoji: '✅', label: 'Təsdiqləndi' },
  pending_review: { family: 'amber', emoji: '⏳', label: 'Gözləyir' },
  rejected: { family: 'rose', emoji: '❌', label: 'İmtina edildi' },
  urgent: { family: 'rose', emoji: '🔴', label: 'Təcili' },
  high: { family: 'orange', emoji: '🟠', label: 'Yüksək' },
  medium: { family: 'amber', emoji: '🟡', label: 'Orta' },
  low: { family: 'emerald', emoji: '🟢', label: 'Aşağı' },
  draft: { family: 'slate', emoji: '—', label: 'Qaralama' },
  published: { family: 'emerald', emoji: '—', label: 'Aktiv' },
  completed: { family: 'slate', emoji: '—', label: 'Tamamlandı' },
  archived: { family: 'slate', emoji: '—', label: 'Arxivlənmiş' },
  scenario_a_compliant: { family: 'emerald', emoji: '⭐', label: 'Ssenari A' },
  scenario_b_gap: { family: 'amber', emoji: '⚠️', label: 'Ssenari B' },
  scenario_c_missing_sprite: { family: 'rose', emoji: '❌', label: 'Ssenari C' },
};

export const STATUS_VALUES: string[] = Object.keys(MAP);

/**
 * Naməlum dəyər heç vaxt crash etmir: neutral slate ailəsi + xam dəyər etiket
 * kimi. (Bilinməyən status ekranı göstərməyə dayandırmamalıdır — data ilə UI
 * arasında yarış yoxdur, dürüst göstərmək var.)
 */
export function statusChip(value: string): StatusChip {
  const entry = MAP[value] ?? { family: 'slate', emoji: '—', label: value };
  const { family, emoji, label } = entry;
  return {
    family,
    emoji,
    label,
    classes: `${STATUS_CHIP_SHAPE} bg-${family}-50 text-${family}-700 border border-${family}-200`,
  };
}
