export const FOCUS_RING_CLASS = 'focus-visible:ring-2 focus-visible:ring-[var(--primary-neon)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background-dark)]';

export const DREAM_CONFIG_BUTTON_STYLE = { padding: '0.5rem 1rem' } as const;

// Base style for the Dream Config action buttons that can show an inline spinner.
export const DREAM_CONFIG_LOADING_BUTTON_STYLE = {
  ...DREAM_CONFIG_BUTTON_STYLE,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.4rem',
} as const;

// Primary (accent) variant used by the "Run Now" button.
export const DREAM_CONFIG_RUN_BUTTON_STYLE = {
  ...DREAM_CONFIG_LOADING_BUTTON_STYLE,
  background: 'var(--primary-neon)',
  color: '#000',
} as const;
