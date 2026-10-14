import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { AuditReviewCenter } from './AuditReviewCenter';
import type { Submission } from '../types';

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

const submission = (id: string, submitted_at: string, risky = false): Submission => ({
  id,
  task_id: id,
  store_id: id,
  photo_url: '/photo.jpg',
  status: 'pending_review',
  location_unverified: risky,
  reviewer_feedback: null,
  metadata: {},
  submitted_at,
  reviewed_at: null,
  task: {
    id,
    title: id,
    description: '',
    reference_image_url: null,
    priority: 'medium',
    status: 'published',
    deadline: submitted_at,
    created_at: submitted_at,
  },
  store: {
    id,
    store_code: id,
    name: `Mağaza ${id}`,
    address: null,
    city: 'Bakı',
    latitude: null,
    longitude: null,
    is_active: true,
    created_at: submitted_at,
  },
});

it('puts risky audits first and opens the next pending audit after approval', async () => {
  const approve = vi.fn().mockResolvedValue(true);
  const submissions = [
    submission('ordinary', '2026-10-12T10:00:00Z'),
    submission('risk', '2026-10-13T10:00:00Z', true),
  ];
  function Harness() {
    const [selected, setSelected] = useState<Submission | null>(null);
    return (
      <AuditReviewCenter
        submissions={submissions}
        selectedSubmission={selected}
        setSelectedSubmission={setSelected}
        onApprove={approve}
        onReject={vi.fn()}
      />
    );
  }
  render(<Harness />);
  const rows = screen.getAllByRole('button', { name: /Mağaza (risk|ordinary)/ });
  expect(rows[0].textContent).toContain('risk');
  fireEvent.click(rows[0]);
  fireEvent.click(screen.getByRole('button', { name: '✅ Təsdiq Et' }));
  await waitFor(() => expect(approve).toHaveBeenCalledWith('risk'));
  await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('ordinary'));
});

it('hides historical brand guesses from the audit photo', () => {
  const old = submission('old', '2026-10-13T10:00:00Z');
  old.ai_score = 91;
  old.ai_detections = [
    {
      id: 'legacy-1',
      sku: 'sprite',
      label: 'Sprite 0.5L',
      confidence: 0.9,
      box: { x: 10, y: 10, width: 20, height: 20 },
      color: '#008B47',
      shelfRow: 1,
      facingIndex: 1,
    },
  ];
  render(
    <AuditReviewCenter
      submissions={[old]}
      selectedSubmission={old}
      setSelectedSubmission={vi.fn()}
      onApprove={vi.fn()}
      onReject={vi.fn()}
    />,
  );
  expect(screen.getByText(/köhnə SKU işarəsi gizlədildi/)).toBeTruthy();
  expect(screen.getByText(/Köhnə balı qərar üçün sübut saymayın/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /AI Qutuları/ })).toBeNull();
});
