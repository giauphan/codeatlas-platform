export const FOCUS_RING_CLASS = 'focus-visible:ring-2 focus-visible:ring-[var(--primary-neon)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background-dark)]';

export const DREAM_CONFIG_BUTTON_STYLE = { padding: '0.5rem 1rem' } as const;

export const DREAM_CONFIG_LOADING_BUTTON_STYLE = {
  ...DREAM_CONFIG_BUTTON_STYLE,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.4rem',
} as const;
