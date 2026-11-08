import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { portalService } from './lib/portalApi';
import { fetchAuthStatus, fetchIdentity } from './lib/panelAuth';
vi.mock('./lib/panelAuth', () => ({
  fetchAuthStatus: vi.fn(),
  fetchIdentity: vi.fn(),
  storedKey: () => null,
  clearStoredKey: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('./lib/portalApi', () => ({
  PortalApiError: class extends Error {},
  portalService: {
    getMetrics: vi.fn(),
    getStores: vi.fn(),
    getTasks: vi.fn(),
    getSubmissions: vi.fn(),
    getProducts: vi.fn(),
    getShelfPositions: vi.fn(),
    getShelfMetrics: vi.fn(),
    createTask: vi.fn(),
  },
}));
beforeEach(() => {
  vi.mocked(fetchAuthStatus).mockResolvedValue({
    required: false,
    liveKeys: 0,
    bootstrapConfigured: false,
    bootstrapProblem: null,
    detail: '',
  });
  vi.mocked(fetchIdentity).mockRejectedValue(new Error('identity unavailable'));
  for (const fn of Object.values(portalService)) vi.mocked(fn).mockResolvedValue([] as never);
  vi.mocked(portalService.getMetrics).mockResolvedValue({
    totalStores: 0,
    activeTasks: 0,
    pendingReviews: 0,
    complianceRate: 0,
  });
  HTMLElement.prototype.scrollTo = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe('portal failure states', () => {
  it('does not claim the panel is open when authentication status is unavailable', async () => {
    vi.mocked(fetchAuthStatus).mockRejectedValue(new Error('offline'));
    render(<App />);
    expect(await screen.findByText('Giriş vəziyyəti yoxlanıla bilmədi')).toBeTruthy();
    expect(screen.queryByText('Panel açıqdır.')).toBeNull();
    expect(portalService.getTasks).not.toHaveBeenCalled();
  });
  it('keeps failed tasks distinct from an empty task list', async () => {
    vi.mocked(portalService.getTasks).mockRejectedValue(new Error('offline'));
    render(<App />);
    await waitFor(() => expect(portalService.getTasks).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Tapşırıqlar' }));
    expect(await screen.findByText('Məlumat yüklənə bilmədi')).toBeTruthy();
    expect(screen.queryByText(/Hələ planogram tapşırığı yoxdur/)).toBeNull();
  });
  it('surfaces a failed write as an assertive error toast, not a success-styled one', async () => {
    vi.mocked(portalService.getStores).mockResolvedValue([{ id: 'a', name: 'Mağaza A' }] as never);
    vi.mocked(portalService.createTask).mockRejectedValue(new Error('offline'));
    render(<App />);
    await waitFor(() => expect(portalService.getTasks).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole('button', { name: /Yeni Təlimat Yarat/ })[0]);
    fireEvent.change(await screen.findByLabelText('Tapşırığın Başlığı *'), {
      target: { value: 'Yoxlama' },
    });
    fireEvent.change(screen.getByLabelText('Düzülüş Təlimatı və Facing Qaydaları *'), {
      target: { value: 'Rəfi yoxlayın' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mağaza A' }));
    const form = screen.getByLabelText('Tapşırığın Başlığı *').closest('form');
    if (!form) throw new Error('Form missing');
    fireEvent.submit(form);
    const toast = await screen.findByRole('alert');
    expect(toast.textContent).toContain('Əməliyyat alınmadı — offline');
    expect(toast.getAttribute('aria-live')).toBe('assertive');
    expect(toast.querySelector('.bg-bad')).toBeTruthy();
    expect(toast.querySelector('.bg-ok')).toBeNull();
  });

  it('loads tasks even when the independent product request fails', async () => {
    vi.mocked(portalService.getProducts).mockRejectedValue(new Error('offline'));
    render(<App />);
    await waitFor(() => expect(portalService.getTasks).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Tapşırıqlar' }));
    expect(await screen.findByText(/Hələ planogram tapşırığı yoxdur/)).toBeTruthy();
    expect(screen.queryByText('Məlumat yüklənə bilmədi')).toBeNull();
  });
});
