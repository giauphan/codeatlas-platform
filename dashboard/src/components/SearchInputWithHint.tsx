import React from 'react';
import { Search, X } from 'lucide-react';
import { KbdHint } from './KbdHint';
import { FOCUS_RING_CLASS } from '../lib/constants';

interface BaseSearchInputWithHintProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSearch: () => void;
  placeholder?: string;
  ariaLabel?: string;
}

interface ClearableSearchProps extends BaseSearchInputWithHintProps {
  hasClearButton: true;
  onClear: () => void;
}

interface NonClearableSearchProps extends BaseSearchInputWithHintProps {
  hasClearButton?: false;
  onClear?: never;
}

type SearchInputWithHintProps = ClearableSearchProps | NonClearableSearchProps;

/**
 * A reusable search input component that provides a standardized UI for search fields.
 * Includes a semantic search icon, an "Enter" key hint (`KbdHint`), and an optional clear button.
 * It automatically adjusts inner padding to make room for the hint and clear button based on input state.
 *
 * Critical use cases:
 * - Full-width semantic search bars where an explicit "Enter" is needed to execute.
 * - Views needing a unified design language for their search queries.
 *
 * @example
 * <SearchInputWithHint
 *    value={query}
 *    onChange={e => setQuery(e.target.value)}
 *    onSearch={() => fetchResults(query)}
 *    placeholder="Search items..."
 * />
 */
export const SearchInputWithHint: React.FC<SearchInputWithHintProps> = ({
  value,
  onChange,
  onSearch,
  onClear,
  placeholder = "Search...",
  ariaLabel = "Search input",
  hasClearButton = false
}) => {
  if (hasClearButton && !onClear) {
    throw new Error("SearchInputWithHint: 'onClear' must be defined when 'hasClearButton' is true.");
  }

  // If we expect a clear button AND there's text, we need extra room
  const showClearBtn = hasClearButton && value.length > 0;

  const styles = {
    paddingRight: showClearBtn ? '4.5rem' : '3.5rem',
    // Instead of changing `right`, we change `transform` to prevent layout thrashing
    kbdHintTransform: showClearBtn ? 'translateX(-1.5rem)' : 'translateX(0)'
  };

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
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSearch();
          }
        }}
      />
      <KbdHint icon="↵" text="Enter" top="0.85rem" right="1rem" transform={styles.kbdHintTransform} />

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
