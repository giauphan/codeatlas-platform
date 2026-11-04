import { FOCUS_RING_CLASS } from '../../lib/constants';

interface FilterPillGroupProps<T extends string> {
  readonly ariaLabel: string;
  readonly options: readonly T[];
  readonly selected: T;
  readonly onSelect: (option: T) => void;
  readonly formatLabel?: (option: T) => string;
}

export function FilterPillGroup<T extends string>(props: Readonly<FilterPillGroupProps<T>>) {
  const {
    ariaLabel,
    options,
    selected,
    onSelect,
    formatLabel = (option) => option,
  } = props;
  return (
    <fieldset
      aria-label={ariaLabel}
      style={{ border: 'none', padding: 0, margin: 0, display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}
    >
      {options.map((option) => {
        const isSelected = selected === option;
        return (
          <button
            key={option}
            type="button"
            onClick={() => onSelect(option)}
            aria-pressed={isSelected}
            className={FOCUS_RING_CLASS}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.1)',
              background: isSelected ? 'rgba(0,240,255,0.15)' : 'rgba(0,0,0,0.2)',
              color: isSelected ? 'var(--primary-neon)' : 'var(--text-muted)',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.85rem',
              transition: 'all 0.2s',
              outline: 'none',
            }}
          >
            {formatLabel(option)}
          </button>
        );
      })}
    </fieldset>
  );
}
