## 2024-08-20 - Add loading spinner to async submit button
**Learning:** Adding a spinner to a button during an async operation without preserving the text causes a layout shift and reduces accessibility context.
**Action:** Always append the text alongside the spinner (e.g., `<><Loader2 className="animate-spin" size={16} style={{ marginRight: '0.25rem', verticalAlign: 'text-bottom' }} /> Saving...</>`) to preserve context and layout.
