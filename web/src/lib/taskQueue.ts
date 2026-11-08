import type { Task } from '../types';

export type TaskQueueFilter = 'all' | 'overdue' | 'today' | 'active' | 'draft' | 'closed';

/** The calendar day an instant falls on in Baku — the timezone the shelves are in. */
export const bakuDay = (date: Date) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Baku',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

export function taskIsOverdue(task: Task, now = new Date()): boolean {
  const deadline = new Date(task.deadline);
  return (
    task.status === 'published' &&
    !Number.isNaN(deadline.getTime()) &&
    bakuDay(deadline) < bakuDay(now)
  );
}

export function filterTaskQueue(
  tasks: Task[],
  filter: TaskQueueFilter,
  query: string,
  storeId: string,
  now = new Date(),
): Task[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('az-AZ');
  return tasks
    .filter((task) => {
      const deadline = new Date(task.deadline);
      const matchesFilter =
        filter === 'all' ||
        (filter === 'overdue' && taskIsOverdue(task, now)) ||
        (filter === 'today' &&
          task.status === 'published' &&
          !Number.isNaN(deadline.getTime()) &&
          bakuDay(deadline) === bakuDay(now)) ||
        (filter === 'active' && task.status === 'published') ||
        (filter === 'draft' && task.status === 'draft') ||
        (filter === 'closed' && (task.status === 'completed' || task.status === 'archived'));
      return (
        matchesFilter &&
        (!storeId || task.store_id === storeId || task.assigned_stores?.includes(storeId)) &&
        (!normalizedQuery ||
          `${task.title} ${task.description}`.toLocaleLowerCase('az-AZ').includes(normalizedQuery))
      );
    })
    .sort((a, b) => {
      const rank = (task: Task) =>
        taskIsOverdue(task, now) ? 0 : task.status === 'published' ? 1 : 2;
      return rank(a) - rank(b) || new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
    });
}
