import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PanelUsersModal } from './PanelUsersModal';
import type { ManagedUserRow } from '../lib/panelAuth';

const mocks = vi.hoisted(() => ({
  fetchUsers: vi.fn(),
  deleteUser: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  mintKey: vi.fn(),
  revokeUserKeys: vi.fn(),
}));

vi.mock('../lib/panelAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/panelAuth')>();
  return { ...actual, ...mocks };
});

const person: ManagedUserRow = {
  id: 'usr-merch-003',
  fullName: 'Eldar Məmmədov',
  email: 'merchandiser@retail.oneteam.az',
  role: 'MERCHANDISER',
  phone: '+994503334455',
  joinedVia: 'telegram',
  liveKeys: 0,
  submissions: 0,
  isSelf: false,
  deletable: true,
  blockedBy: null,
};

function setup() {
  mocks.fetchUsers.mockResolvedValue({
    users: [person],
    roles: ['ADMIN', 'SUPERVISOR', 'MERCHANDISER', 'STORE_STAFF'],
    adminCount: 1,
  });
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(<PanelUsersModal onClose={onClose} onChanged={onChanged} />);
  return { onClose, onChanged };
}

async function openConfirm() {
  await screen.findByText('Eldar Məmmədov');
  fireEvent.click(screen.getByRole('button', { name: 'Sil' }));
  return screen.findByRole('dialog', { name: 'İstifadəçini silməyi təsdiqlə' });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('user delete confirmation', () => {
  it('asks before deleting and names the person', async () => {
    setup();
    await openConfirm();
    expect(screen.getByText('"Eldar Məmmədov" silinsin?')).toBeTruthy();
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });

  it('Ləğv et closes the confirm without deleting and keeps the list open', async () => {
    const { onClose } = setup();
    await openConfirm();
    fireEvent.click(screen.getByRole('button', { name: 'Ləğv et' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'İstifadəçini silməyi təsdiqlə' })).toBeNull(),
    );
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'İstifadəçilər və rollar' })).toBeTruthy();
  });

  it('Bəli, sil deletes exactly that user and refreshes the list', async () => {
    mocks.deleteUser.mockResolvedValue(undefined);
    const { onChanged } = setup();
    await openConfirm();
    fireEvent.click(screen.getByRole('button', { name: 'Bəli, sil' }));
    await waitFor(() => expect(mocks.deleteUser).toHaveBeenCalledWith('usr-merch-003'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.queryByRole('dialog', { name: 'İstifadəçini silməyi təsdiqlə' })).toBeNull();
    expect(screen.getByText('Eldar Məmmədov silindi.')).toBeTruthy();
  });

  it('Escape closes only the confirm, not the whole modal', async () => {
    const { onClose } = setup();
    await openConfirm();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'İstifadəçini silməyi təsdiqlə' })).toBeNull(),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'İstifadəçilər və rollar' })).toBeTruthy();
  });

  it('a refused delete keeps the confirm open and shows the server reason', async () => {
    const { PanelAuthError } = await import('../lib/panelAuth');
    mocks.deleteUser.mockRejectedValue(new PanelAuthError('Audit təqdimatı var, silinmir.', 409));
    setup();
    await openConfirm();
    fireEvent.click(screen.getByRole('button', { name: 'Bəli, sil' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Audit təqdimatı var'),
    );
    expect(screen.getByRole('dialog', { name: 'İstifadəçini silməyi təsdiqlə' })).toBeTruthy();
  });
});
