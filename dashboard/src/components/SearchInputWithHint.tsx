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

/**
 * A reusable search input component that provides a standardized UI for search fields.
 * Includes a semantic search icon, an "Enter" key hint (`KbdHint`), and an optional clear button.
 * It automatically adjusts inner padding to make room for the hint and clear button based on input state.
 *
 * Critical use cases:
 * - Full-width semantic search bars where an explicit "Enter" is needed to execute.
 * - Views needing a unified design language for their search queries.
 */
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
    if (process.env.NODE_ENV === 'development') {
      console.warn("SearchInputWithHint: 'hasClearButton' is true but 'onClear' was not provided. The clear button will not function correctly.");
    }
  }

  // Compute styling logic here (using useMemo to avoid re-renders)
  const styles = useMemo(() => {
    // If we expect a clear button AND there's text, we need extra room
    const showClearBtn = hasClearButton && value.length > 0;
    return {
      paddingRight: showClearBtn ? '4.5rem' : '3.5rem',
      kbdHintRight: showClearBtn ? '2.5rem' : '1rem'
    } as const;
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
      <KbdHint icon="↵" text="Enter" top="0.85rem" right={styles.kbdHintRight} />

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
