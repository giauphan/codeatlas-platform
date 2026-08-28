import React, { useMemo } from 'react';
import { Search, X } from 'lucide-react';
import { KbdHint } from './KbdHint';
import { FOCUS_RING_CLASS } from '../lib/constants';

interface SearchInputWithHintProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onClear?: () => void;
  placeholder?: string;
  ariaLabel?: string;
  // If true, the clear button takes up space and we need to push the kbd hint left
  hasClearButton?: boolean;
}

export const SearchInputWithHint: React.FC<SearchInputWithHintProps> = ({
  value,
  onChange,
  onKeyDown,
  onClear,
  placeholder = "Search...",
  ariaLabel = "Search input",
  hasClearButton = false
}) => {
  if (hasClearButton && !onClear) {
    console.warn("SearchInputWithHint: 'hasClearButton' is true but 'onClear' was not provided. The clear button will not function correctly.");
  }

  // Compute styling logic here (using useMemo to avoid re-renders)
  const styles = useMemo(() => {
    // If we expect a clear button AND there's text, we need extra room
    const showClearBtn = hasClearButton && value.length > 0;
    return {
      paddingRight: showClearBtn ? '4.5rem' : '3.5rem',
      kbdHintRight: showClearBtn ? '2.5rem' : '1rem'
    };
  }, [value, hasClearButton]);

  return (
    <div style={{ flex: 1, minWidth: '280px', position: 'relative' }}>
      <Search size={18} style={{ position: 'absolute', left: '1rem', top: '0.85rem', color: 'var(--text-muted)' }} />
      <input
        type="text"
        className={`search-input-field ${FOCUS_RING_CLASS}`}
        placeholder={placeholder}
        aria-label={ariaLabel}
        style={{ paddingRight: styles.paddingRight }}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
      <KbdHint icon="↵" text="Enter" top="0.85rem" right={styles.kbdHintRight as any} />

      {hasClearButton && value && onClear && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={onClear}
          className={`clear-search-btn ${FOCUS_RING_CLASS}`}
          style={{ top: '0.85rem' }}
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
};
