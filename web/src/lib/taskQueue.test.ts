import { describe, expect, it } from 'vitest';
import { filterTaskQueue, taskIsOverdue } from './taskQueue';
import type { Task } from '../types';

const makeTask = (
  id: string,
  status: Task['status'],
  deadline: string,
  store_id: string,
): Task => ({
  id,
  title: id,
  description: 'Rəf yoxlaması',
  reference_image_url: null,
  priority: 'medium',
  status,
  deadline,
  store_id,
  created_at: deadline,
});

describe('task work queue', () => {
  const now = new Date('2026-10-14T10:00:00+04:00');
  const tasks = [
    makeTask('gecikən', 'published', '2026-10-13T18:00:00+04:00', 'a'),
    makeTask('bu gün', 'published', '2026-10-14T18:00:00+04:00', 'b'),
    makeTask('bağlı', 'completed', '2026-10-12T18:00:00+04:00', 'a'),
  ];

  it('does not call completed work overdue', () => {
    expect(taskIsOverdue(tasks[0], now)).toBe(true);
    expect(taskIsOverdue(tasks[2], now)).toBe(false);
  });

  it('filters by local day, store and search, with overdue first', () => {
    expect(filterTaskQueue(tasks, 'all', '', '', now).map((task) => task.id)).toEqual([
      'gecikən',
      'bu gün',
      'bağlı',
    ]);
    expect(filterTaskQueue(tasks, 'today', '', '', now).map((task) => task.id)).toEqual(['bu gün']);
    expect(filterTaskQueue(tasks, 'all', 'gecikən', 'a', now).map((task) => task.id)).toEqual([
      'gecikən',
    ]);
  });
});
