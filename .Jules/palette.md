## 2026-06-29 - Missing ARIA Labels on Icon-Only Buttons in Mapped Arrays
**Learning:** Found a pattern where dynamic icon-only buttons (like Copy/Delete actions) inside mapped arrays lacked `aria-label` and `title` attributes, making them inaccessible to screen readers and lacking tooltips for mouse users.
**Action:** Ensure that whenever mapping over arrays to render list items with icon-only actions, semantic `aria-label` and `title` attributes are included on the buttons for accessibility.
