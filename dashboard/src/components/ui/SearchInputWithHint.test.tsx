import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SearchInputWithHint } from './SearchInputWithHint';

describe('SearchInputWithHint', () => {
  it('renders input, placeholder, and kbd hint', () => {
    const onChange = vi.fn();
    const onSearch = vi.fn();

    const { rerender } = render(
      <SearchInputWithHint
        value=""
        onChange={onChange}
        onSearch={onSearch}
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
    const onSearch = vi.fn();
    const onClear = vi.fn();

    render(
      <SearchInputWithHint
        value="something"
        onChange={onChange}
        onSearch={onSearch}
        onClear={onClear}
        hasClearButton={true}
      />
    );

    const clearButton = screen.getByLabelText('Clear search');
    expect(clearButton).toBeInTheDocument();

    fireEvent.click(clearButton);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('calls onChange and onSearch when user interacts', () => {
    const onChange = vi.fn();
    const onSearch = vi.fn();

    const { rerender } = render(
      <SearchInputWithHint
        value=""
        onChange={onChange}
        onSearch={onSearch}
      />
    );

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'test' } });
    expect(onChange).toHaveBeenCalledTimes(1);

    // Provide a non-empty string to satisfy `value.trim()`
    rerender(
      <SearchInputWithHint
        value="test"
        onChange={onChange}
        onSearch={onSearch}
      />
    );

    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('does not call onSearch when value is empty or only whitespace', () => {
    const onChange = vi.fn();
    const onSearch = vi.fn();

    render(
      <SearchInputWithHint
        value="   "
        onChange={onChange}
        onSearch={onSearch}
      />
    );

    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('logs a console.warn when hasClearButton is true but onClear is missing in development', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      // @ts-expect-error intentionally missing onClear to test runtime warning
      <SearchInputWithHint
        value="something"
        onChange={vi.fn()}
        onSearch={vi.fn()}
        hasClearButton={true}
      />
    );

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("SearchInputWithHint: 'onClear' must be defined when 'hasClearButton' is true")
    );

    consoleWarnSpy.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });
});
