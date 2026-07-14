## 2026-07-14 - Fix timing attack vulnerability in superadmin API key comparison
**Vulnerability:** Hardcoded bypass based on string comparison of keys (`apiKey === superAdminKey`) which is vulnerable to timing attacks.
**Learning:** String comparison operators (`===`, `==`) leak information about how many characters match before a mismatch occurs by exiting early.
**Prevention:** Always use constant-time comparison functions like `crypto.timingSafeEqual` for comparing secrets like passwords, tokens, or API keys. Ensure length checks are handled securely.
