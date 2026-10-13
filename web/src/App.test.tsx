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
    fireEvent.click(screen.getByRole('button', { name: 'Planogram Tapşırıqları' }));
    expect(await screen.findByText('Məlumat yüklənə bilmədi')).toBeTruthy();
    expect(screen.queryByText(/Hələ planogram tapşırığı yoxdur/)).toBeNull();
  });
  it('loads tasks even when the independent product request fails', async () => {
    vi.mocked(portalService.getProducts).mockRejectedValue(new Error('offline'));
    render(<App />);
    await waitFor(() => expect(portalService.getTasks).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Planogram Tapşırıqları' }));
    expect(await screen.findByText(/Hələ planogram tapşırığı yoxdur/)).toBeTruthy();
    expect(screen.queryByText('Məlumat yüklənə bilmədi')).toBeNull();
  });
});
