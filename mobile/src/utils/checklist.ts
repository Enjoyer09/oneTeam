import type { ChecklistQuestion } from '@oneteam/types';
export function answerError(q: ChecklistQuestion, raw = ''): string | null {
  const value = raw.trim();
  if (!value) return q.required === false ? null : 'Bu suala cavab verin.';
  const type = q.type ?? 'boolean';
  if (type === 'boolean' && !['true', 'false'].includes(value)) return 'Bəli və ya Xeyr seçin.';
  if (type === 'single_choice' && !q.options?.includes(value)) return 'Siyahıdan cavab seçin.';
  if (type === 'number') {
    const normalized = value.replace(',', '.');
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return 'Düzgün rəqəm yazın.';
    const n = Number(normalized);
    if (!Number.isFinite(n)) return 'Düzgün rəqəm yazın.';
    if (q.minValue !== undefined && n < q.minValue) return `Ən azı ${q.minValue} olmalıdır.`;
    if (q.maxValue !== undefined && n > q.maxValue) return `Ən çoxu ${q.maxValue} ola bilər.`;
  }
  return null;
}
export function answerValue(q: ChecklistQuestion, raw: string): string | number | boolean {
  if ((q.type ?? 'boolean') === 'boolean') return raw === 'true';
  if (q.type === 'number') return Number(raw.trim().replace(',', '.'));
  return raw.trim();
}
