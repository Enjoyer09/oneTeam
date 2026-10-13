import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EvidenceViewer } from './EvidenceViewer';
import { fitEvidence } from '../../lib/evidenceGeometry';
import type { DetectionItem } from '../../types';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe('evidence geometry and recovery', () => {
  it.each([
    [900, 1600, 202.5, 360],
    [1600, 900, 600, 337.5],
    [1200, 900, 480, 360],
  ])('fits %s × %s without cropping', (w, h, expectedW, expectedH) => {
    expect(fitEvidence(w, h, 600, 360)).toEqual({ width: expectedW, height: expectedH });
  });
  it('zooms the photo and its detection plane together', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(360);
    const det = {
      id: 'd',
      label: 'Məhsul',
      confidence: 0.9,
      color: '#f00',
      box: { x: 10, y: 20, width: 30, height: 40 },
    } as DetectionItem;
    render(<EvidenceViewer src="/photo.jpg" alt="Audit" detections={[det]} />);
    const photo = screen.getByAltText('Audit');
    Object.defineProperties(photo, {
      naturalWidth: { value: 900 },
      naturalHeight: { value: 1600 },
    });
    fireEvent.load(photo);
    expect(photo.parentElement?.style.width).toBe('202.5px');
    const box = screen.getByTitle('Məhsul (90%)');
    expect(box.parentElement).toBe(photo.parentElement);
    expect(box.style.left).toBe('10%');
    fireEvent.click(screen.getByRole('button', { name: 'Fotonu böyüt' }));
    expect(photo.parentElement?.style.width).toBe('303.75px');
    fireEvent.click(screen.getByRole('button', { name: 'Tam foto' }));
    expect(photo.parentElement?.style.width).toBe('202.5px');
  });
  it('uses an explicit missing state instead of a logo and recovers from failed sources', () => {
    const view = render(<EvidenceViewer alt="Nümunə" />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(/nümunə foto əlavə edilməyib/)).toBeTruthy();
    view.rerender(<EvidenceViewer alt="Nümunə" src="/failed.jpg" />);
    fireEvent.error(screen.getByAltText('Nümunə'));
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fotonu yenidən yüklə' }));
    expect(screen.queryByRole('alert')).toBeNull();
    view.rerender(<EvidenceViewer alt="Nümunə" src="/new.jpg" />);
    expect(screen.getByAltText('Nümunə').getAttribute('src')).toBe('/new.jpg');
  });
});
