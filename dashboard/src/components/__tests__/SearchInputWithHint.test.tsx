import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SearchInputWithHint } from '../SearchInputWithHint';

describe('SearchInputWithHint', () => {
  it('renders input, placeholder, and kbd hint', () => {
    const onChange = vi.fn();
    const onKeyDown = vi.fn();

    render(
      <SearchInputWithHint
        value=""
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder="Test placeholder"
        ariaLabel="Test label"
      />
    );

    const input = screen.getByPlaceholderText('Test placeholder');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-label', 'Test label');

    expect(screen.getByText(/Enter/)).toBeInTheDocument();

    // Clear button shouldn't be rendered if value is empty or hasClearButton is false
    expect(screen.queryByLabelText('Clear search')).not.toBeInTheDocument();
  });

  it('renders clear button and calls onClear when clicked', () => {
    const onChange = vi.fn();
    const onKeyDown = vi.fn();
    const onClear = vi.fn();

    render(
      <SearchInputWithHint
        value="something"
        onChange={onChange}
        onKeyDown={onKeyDown}
        onClear={onClear}
        hasClearButton={true}
      />
    );

    const clearButton = screen.getByLabelText('Clear search');
    expect(clearButton).toBeInTheDocument();

    fireEvent.click(clearButton);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('calls onChange and onKeyDown when user interacts', () => {
    const onChange = vi.fn();
    const onKeyDown = vi.fn();

    render(
      <SearchInputWithHint
        value=""
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
    );

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'test' } });
    expect(onChange).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });
});
