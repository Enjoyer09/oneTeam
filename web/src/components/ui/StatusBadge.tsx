import React from 'react';
import { statusChip } from '../../lib/statusMap';

/**
 * §10.4 canonical status badge — ailə/etiket xəritəsi `lib/statusMap`-dədir
 * (§11 "authoritative" qaydası), burada yalnız JSX şəkli var.
 * Emoji '—' olan statuslarda (task statusları) yalnız etiket görünür.
 */
export function StatusBadge({ value, className }: { value: string; className?: string }) {
  const chip = statusChip(value);
  const glyph = chip.emoji !== '—' ? `${chip.emoji} ` : '';
  return (
    <span className={`${chip.classes}${className ? ` ${className}` : ''}`}>
      {glyph}
      {chip.label}
    </span>
  );
}
