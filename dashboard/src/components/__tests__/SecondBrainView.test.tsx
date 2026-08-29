import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SecondBrainView } from '../SecondBrainView';

describe('SecondBrainView', () => {
  let mockFetch: any;

  beforeEach(() => {
    mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ concepts: [] }),
      })
    );
    globalThis.fetch = mockFetch;
  });

  it('renders search input and clear button works', async () => {
    render(<SecondBrainView />);

    const searchInput = screen.getByLabelText('Search concepts');
    fireEvent.change(searchInput, { target: { value: 'react' } });

    expect(searchInput).toHaveValue('react');

    const clearButton = screen.getByLabelText('Clear search');
    fireEvent.click(clearButton);

    expect(searchInput).toHaveValue('');
    // Wait for the clear message to be rendered
    await waitFor(() => {
      expect(screen.getByText('Search cleared')).toBeInTheDocument();
    });
  });
});
