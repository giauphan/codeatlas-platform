## 2026-07-14 - Add ARIA attributes to Tab Switcher
**Learning:** Custom interactive elements like a tab switcher built with divs and buttons need proper ARIA attributes to be accessible to screen readers.
**Action:** Always add `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls`, and `role="tabpanel"` with appropriate IDs when implementing custom tab interfaces.
