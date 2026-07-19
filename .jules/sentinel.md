## 2026-07-14 - Insecure Security Context Bypass in Database Connection
**Vulnerability:** A conditional statement in the database connection initialization code allowed bypassing Row-Level Security (RLS) based on environment variables (`CODEATLAS_BYPASS_RLS` or `NODE_ENV === 'test'`).
**Learning:** Hardcoding security bypasses, even for testing or local development, within the core production code path is extremely dangerous. It creates a critical vulnerability if those environment variables are accidentally set or misconfigured in a production environment.
**Prevention:** Do not put bypass mechanisms in production code. The best prevention is to just remove the bypass entirely, as done here, rather than trying to engineer around it. It is simpler, uses less code, and leaves no configuration surface to misconfigure. Environments that previously relied on the bypass (like dev or CI testing) will need to adjust by either ensuring a working RLS setup or using appropriate mocking.
## 2024-05-18 - Added Helmet middleware

**Vulnerability:** Express app missing security headers (e.g. X-Powered-By exposed, missing XSS protection, etc.)
**Learning:** Security headers are not enabled by default in Express and must be explicitly configured using middleware like helmet. Cross-origin configuration must be considered to avoid breaking existing CORS implementations.
**Prevention:** Use helmet by default when initializing new Express applications and verify configuration against CORS needs.
