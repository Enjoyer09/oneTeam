import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sidebar } from './Sidebar';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Sidebar
        activeTab="dashboard"
        setActiveTab={() => {}}
        pendingCount={0}
        drawerOpen={open}
        onCloseDrawer={() => setOpen(false)}
      />
      <main id="oneteam-content">
        <button onClick={() => setOpen(true)}>Menyu aç</button>
        <button>Əsas əməliyyat</button>
      </main>
    </>
  );
}
describe('mobile navigation focus', () => {
  it('hides the closed drawer, traps focus while open and restores it after Escape', () => {
    vi.stubGlobal(
      'matchMedia',
      vi
        .fn()
        .mockReturnValue({
          matches: false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }),
    );
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.parentElement;
    });
    render(<Harness />);
    const aside = document.getElementById('oneteam-sidebar');
    if (!aside) throw new Error('Sidebar missing');
    expect(aside.inert).toBe(true);
    expect(aside.getAttribute('aria-hidden')).toBe('true');
    const opener = screen.getByRole('button', { name: 'Menyu aç' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog')).toBe(aside);
    expect(aside.inert).toBe(false);
    expect(document.getElementById('oneteam-content')?.inert).toBe(true);
    const close = screen.getByRole('button', { name: 'Menyunu bağla' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rəf Xəritəsi' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(aside.inert).toBe(true);
    expect(document.activeElement).toBe(opener);
    expect(document.getElementById('oneteam-content')?.inert).toBe(false);
  });
});
