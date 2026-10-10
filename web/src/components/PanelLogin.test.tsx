/**
 * PanelLogin behaviour tests — the first real component tests in this repo.
 * ============================================================================
 * jsdom + @testing-library/react, run by vitest (`npm run test:web`, inside web/).
 *
 * The ui-setup contract: because the module freezes `API_BASE` when the
 * component module is first imported, each test imports the component/panelAuth
 * fresh via `vi.resetModules()`, *then* sets a `VITE_API_BASE_URL` so the
 * requests go to the mock server. Otherwise the tests would either hit a real
 * network or assert on nothing.
 *
 * Three of the flows are worth guarding because they can silently drift while
 * the login screen "looks fine":
 *  - a blank key must refuse locally (the API would refuse it too, but the
 *    screen should not even ask);
 *  - a wrong key must surface the human message, not a raw fetch error;
 *  - bootstrapProblem must be shown, because it states that nothing typed will
 *    work until the operator fixes the bootstrap key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PanelAuthStatus } from '../lib/panelAuth';

/** A saved key, registered as the bearer on the identity request. */
const KEY = 'otp_test-1234';
const OK_STATUS: PanelAuthStatus = {
  required: true,
  liveKeys: 1,
  bootstrapConfigured: true,
  bootstrapProblem: null,
  detail: 'Paneldə giriş tələb olunur',
};

type FetchSig = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let fetchMock: ReturnType<typeof vi.fn<FetchSig>>;
let onSignedIn = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function renderLogin(status: PanelAuthStatus) {
  const { PanelLogin } = await import('./PanelLogin');
  return render(<PanelLogin status={status} onSignedIn={onSignedIn} />);
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  fetchMock = vi.fn<FetchSig>();
  vi.stubGlobal('fetch', fetchMock);
  onSignedIn = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PanelLogin', () => {
  it('renders the key field with its label and the sign-in button', async () => {
    await renderLogin(OK_STATUS);
    expect(screen.getByLabelText('Giriş açarı')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Daxil ol' })).toBeInTheDocument();
    // The label is associated with the password field, the a11y contract this
    // repo now guards structurally — here it is checked in a real DOM.
    expect(screen.getByLabelText('Giriş açarı')).toHaveAttribute('type', 'password');
  });

  it('refuses a blank key without calling the API', async () => {
    await renderLogin(OK_STATUS);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Daxil ol' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Açarı daxil edin.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signs in: stores the key, calls identity, fires onSignedIn', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          userId: 'usr-admin-001',
          fullName: null,
          email: null,
          role: 'SUPERVISOR',
          via: 'panel',
          canManageKeys: true,
          usingBootstrapKey: false,
        },
      }),
    );
    await renderLogin(OK_STATUS);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Giriş açarı'), KEY);
    await user.click(screen.getByRole('button', { name: 'Daxil ol' }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem('oneteam-panel-key')).toBe(KEY);
    // The identity probe is the request that carries the key.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/panel/me'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${KEY}` }),
      }),
    );
  });

  it('shows the human message on a wrong key (401) and does not sign in', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: false, message: 'Geçərsiz açar', error: 'UNAUTHORIZED' }, 401),
    );
    await renderLogin(OK_STATUS);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Giriş açarı'), KEY);
    await user.click(screen.getByRole('button', { name: 'Daxil ol' }));

    expect(await screen.findByText(/Bu açar qəbul edilmədi/)).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('shows the bootstrap problem when the API says nothing will work', async () => {
    await renderLogin({
      ...OK_STATUS,
      bootstrapConfigured: true,
      bootstrapProblem: 'Bootstrap açarı ən azı 24 simvol olmalıdır',
    });

    expect(screen.getByText(/Bootstrap açarı qəbul edilmir/)).toBeInTheDocument();
  });
});
