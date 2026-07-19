## 2026-07-19 - Added Defense-in-Depth Security Headers
**Vulnerability:** The application was missing critical security headers like X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security, and X-XSS-Protection.
**Learning:** This is a crucial defense-in-depth measure missing from the base Express server setup. Instead of importing `helmet`, I implemented a custom middleware to satisfy the boundary constraint "Ask first: Adding new security dependencies".
**Prevention:** Always verify if basic HTTP security headers are set natively or via minimal dependencies when setting up an Express server to reduce attack surface for MIME-sniffing, clickjacking, and XSS.
