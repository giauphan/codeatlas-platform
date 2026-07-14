## 2026-07-14 - Fix Unauthenticated API keys caching
**Vulnerability:** Unauthenticated API keys caching
**Learning:** Hardcoded inputs missing `autoComplete="off"` allow browsers to cache or save sensitive credentials like API keys.
**Prevention:** Always add `autoComplete="off"` to input fields that handle sensitive information like API keys, tokens, or passwords to prevent browser caching.
