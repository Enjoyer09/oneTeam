import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TaskManager } from './TaskManager';
import type { Store } from '../types';
afterEach(cleanup);
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
    submit: () => { const form = screen.getByLabelText('Tapşırığın Başlığı *').closest('form'); if (!form) throw new Error('Form missing'); fireEvent.submit(form); },
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
