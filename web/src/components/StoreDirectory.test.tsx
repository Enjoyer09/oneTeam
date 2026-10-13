import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StoreDirectory } from './StoreDirectory';
import type { Store } from '../types';

afterEach(cleanup);

const store = {
  id: 'store-1',
  store_code: 'TEST_1',
  name: 'Test mağazası',
  city: 'Bakı',
  address: null,
  is_active: true,
} as Store;

describe('store compliance', () => {
  it('does not claim perfect compliance before the first audit', () => {
    render(
      <StoreDirectory
        stores={[store]}
        submissions={[]}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        canEdit={false}
      />,
    );

    expect(screen.getByText('Yoxlama yoxdur')).toBeTruthy();
    expect(screen.queryByText('100%')).toBeNull();
  });
});
