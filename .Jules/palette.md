## 2024-07-11 - Custom Toggle Switch Accessibility
**Learning:** Custom toggle buttons implemented as standard `<button>` elements in this app often lack proper switch semantics, making their state unclear to screen readers.
**Action:** Always add `role="switch"` and `aria-checked={booleanState}` to custom toggle components to accurately convey their function and current state.
