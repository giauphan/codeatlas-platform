import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { KbdHint } from '../KbdHint';

describe('KbdHint', () => {
  it('renders correctly with given props', () => {
    render(<KbdHint icon="↵" text="Enter" top="1rem" right="2rem" />);

    // Check if text is rendered
    expect(screen.getByText(/Enter/)).toBeInTheDocument();

    // Check if icon is rendered
    expect(screen.getByText(/↵/)).toBeInTheDocument();

    // Check styles
    const wrapper = screen.getByText(/Enter/).closest('.search-kbd-hint-wrapper');
    expect(wrapper).toHaveStyle({ top: '1rem', right: '2rem' });
  });
});
