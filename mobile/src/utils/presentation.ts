import type { TaskPriority } from '../types';
export const priorityLabel: Record<TaskPriority, string> = {
  low: 'Aşağı',
  medium: 'Orta',
  high: 'Yüksək',
  urgent: 'Təcili',
};
export function deadlineLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Tarix göstərilməyib';
  return date.toLocaleString('az-AZ', {
    timeZone: 'Asia/Baku',
    day: '2-digit',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}
