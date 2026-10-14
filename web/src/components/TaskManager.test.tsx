import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TaskManager } from './TaskManager';
import type { Store, Task } from '../types';
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
const stores = [
  { id: 'a', name: 'Mağaza A' },
  { id: 'b', name: 'Mağaza B' },
] as Store[];
function setup() {
  const create = vi.fn().mockResolvedValue(true);
  render(
    <TaskManager
      tasks={[]}
      stores={stores}
      isCreateModalOpen
      setIsCreateModalOpen={vi.fn()}
      onCreateTask={create}
    />,
  );
  fireEvent.change(screen.getByLabelText('Tapşırığın Başlığı *'), { target: { value: 'Yoxlama' } });
  fireEvent.change(screen.getByLabelText('Düzülüş Təlimatı və Facing Qaydaları *'), {
    target: { value: 'Rəfi yoxlayın' },
  });
  return {
    create,
    submit: () => {
      const form = screen.getByLabelText('Tapşırığın Başlığı *').closest('form');
      if (!form) throw new Error('Form missing');
      fireEvent.submit(form);
    },
  };
}
describe('explicit task recipients', () => {
  it('starts empty and refuses publication without recipients', () => {
    const { create, submit } = setup();
    expect(
      screen
        .getByRole('button', { name: 'Bütün Mağazalar (Şəbəkə Üzrə)' })
        .getAttribute('aria-pressed'),
    ).toBe('false');
    submit();
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByText('Ən azı bir mağaza seçin.')).toBeTruthy();
  });
  it('deselecting the last store leaves none, never all', () => {
    const { create, submit } = setup();
    const store = screen.getByRole('button', { name: 'Mağaza A' });
    fireEvent.click(store);
    fireEvent.click(store);
    submit();
    expect(create).not.toHaveBeenCalled();
  });
  it('supports removing one recipient from all and sends exactly the remaining store', async () => {
    const { create, submit } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Bütün Mağazalar (Şəbəkə Üzrə)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mağaza A' }));
    expect(screen.getByRole('button', { name: '1 mağazaya dərc et' })).toBeTruthy();
    submit();
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ assigned_stores: ['b'] })),
    );
  });
});

it('publishes checklist and before/after requirement with the selected recipients', async () => {
  const { create, submit } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Mağaza A' }));
  fireEvent.click(screen.getByLabelText('Əvvəl və sonra fotosu tələb olunsun'));
  fireEvent.click(screen.getByRole('button', { name: '+ Sual əlavə et' }));
  fireEvent.change(screen.getByPlaceholderText('Məsələn: Rəf tam doludurmu?'), {
    target: { value: 'Rəf tam doludurmu?' },
  });
  submit();
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        assigned_stores: ['a'],
        requires_before_after_photo: true,
        checklist_schema: [
          { id: expect.any(String), label: 'Rəf tam doludurmu?', type: 'boolean' },
        ],
      }),
    ),
  );
});

it('restores an unfinished task after the panel remounts', async () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Mağaza A' }));
  await waitFor(() => expect(sessionStorage.getItem('oneteam-task-draft-v1')).toContain('Yoxlama'));
  cleanup();
  render(
    <TaskManager
      tasks={[]}
      stores={stores}
      isCreateModalOpen
      setIsCreateModalOpen={vi.fn()}
      onCreateTask={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect((screen.getByLabelText('Tapşırığın Başlığı *') as HTMLInputElement).value).toBe(
      'Yoxlama',
    ),
  );
  expect(screen.getByRole('button', { name: 'Mağaza A' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
});

it('shows the assigned store name in the work queue', () => {
  render(
    <TaskManager
      tasks={[
        {
          id: 'task-a',
          title: 'Rəf yoxlaması',
          description: 'Yoxla',
          reference_image_url: null,
          priority: 'high',
          status: 'published',
          deadline: '2026-10-21T12:00:00Z',
          created_at: '2026-10-14T12:00:00Z',
          store_id: 'a',
        } as Task,
      ]}
      stores={stores}
      isCreateModalOpen={false}
      setIsCreateModalOpen={vi.fn()}
      onCreateTask={vi.fn()}
    />,
  );
  expect(screen.getAllByText('Mağaza A').some((element) => element.tagName === 'SPAN')).toBe(true);
});

it('excludes stores without a region from a regional bulk preview', () => {
  render(
    <TaskManager
      tasks={[]}
      stores={
        [
          { id: 'north', name: 'Şimal', store_code: 'N', region_id: 'north', is_active: true },
          { id: 'unknown', name: 'Naməlum', store_code: 'U', is_active: true },
        ] as Store[]
      }
      isCreateModalOpen={false}
      setIsCreateModalOpen={vi.fn()}
      onCreateTask={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Kütləvi Təlimat Göndər' }));
  fireEvent.change(screen.getByLabelText('Region / Şəhər:'), { target: { value: 'north' } });

  expect(screen.getByText('🎯 Hədəf: 1 mağaza seçildi')).toBeTruthy();
  expect(screen.getByText('Şimal (N)')).toBeTruthy();
  expect(screen.queryByText('Naməlum (U)')).toBeNull();
});
