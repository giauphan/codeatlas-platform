## 2026-07-14 - Insecure Security Context Bypass in Database Connection
**Vulnerability:** A conditional statement in the database connection initialization code allowed bypassing Row-Level Security (RLS) based on environment variables (`CODEATLAS_BYPASS_RLS` or `NODE_ENV === 'test'`).
**Learning:** Hardcoding security bypasses, even for testing or local development, within the core production code path is extremely dangerous. It creates a critical vulnerability if those environment variables are accidentally set or misconfigured in a production environment.
**Prevention:** Do not put bypass mechanisms in production code. The best prevention is to just remove the bypass entirely, as done here, rather than trying to engineer around it. It is simpler, uses less code, and leaves no configuration surface to misconfigure. Environments that previously relied on the bypass (like dev or CI testing) will need to adjust by either ensuring a working RLS setup or using appropriate mocking.
## 2024-05-18 - Added Helmet middleware

**Vulnerability:** Express app missing security headers (e.g. X-Powered-By exposed, missing XSS protection, etc.)
**Learning:** Security headers are not enabled by default in Express and must be explicitly configured using middleware like helmet. Cross-origin configuration must be considered to avoid breaking existing CORS implementations.
**Prevention:** Use helmet by default when initializing new Express applications and verify configuration against CORS needs.
## 2026-07-24 - [Remove Hardcoded API Key Wildcard Bypass]
**Vulnerability:** A hardcoded wildcard `*` was used as the `x-api-key` in a backend-to-backend `fetch` call within `src/presentation/mcpTools.ts` for the `sync_skills` endpoint.
**Learning:** This bypass was likely introduced for convenience during testing or initial development, but hardcoded wildcards or bypass tokens violate the principle of least privilege and can allow unauthorized execution if standard API endpoints are exposed.
**Prevention:** Internal/Server-to-Server API calls should dynamically reference actual secret tokens from environment variables (e.g., `process.env.CODEATLAS_API_KEY`) rather than relying on structural bypasses.
## 2026-07-24 - [Fail Loudly on Missing Security Config]
**Vulnerability:** A fallback to `""` was used when a required security environment variable (`CODEATLAS_API_KEY`) was missing.
**Learning:** Silently falling back to invalid credentials masks configuration errors and can lead to obscure access denied responses (403s), making debugging difficult and potentially leaving endpoints in unexpected states.
**Prevention:** When security configurations are mandatory, throw an explicit error early in the execution path to fail loudly and safely.
## 2026-07-24 - [Handle HTTP Error States Before Parsing JSON]
**Vulnerability:** A missing HTTP status check (`!res.ok`) before calling `res.json()` could lead to unhelpful JSON parse exceptions if the server returned a non-2xx status (e.g., a 401 or 500 error page).
**Learning:** Assuming that an HTTP response will always be JSON when the status code indicates an error masks the true nature of the failure. This makes diagnosing API or authentication failures difficult, especially when interacting with internal secure endpoints.
**Prevention:** Always check `!res.ok` (or equivalent status logic) immediately after a `fetch` request, and throw a descriptive error containing the status code and text *before* attempting to parse the response body as JSON.
## 2026-07-28 - [Enhanced Secrets & Injection Scanning]
**Vulnerability:** Weak coverage for detecting hardcoded API keys and common SQL statements.
**Learning:** The internal `SecurityScanner` relies on hardcoded string matching. It previously missed terms like "apikey", "credential", and SQL commands "select", "insert", "update".
**Prevention:** Regularly review and update static analysis keyword lists to include modern token patterns and complete sets of risky commands.

## 2026-08-08 - Fix arbitrary origin reflection in CORS
**Vulnerability:** The Express HTTP server dynamically reflected wildcard origins (`*`) via `callback(null, true)` inside the `cors` middleware when `allowedList.includes('*')`. If requests are made with `credentials: true`, this creates a critical security vulnerability where any malicious website can make authenticated requests to the API.
**Learning:** Returning boolean `true` dynamically for a wildcard configuration in `cors` bypasses the browser's built-in block against using wildcard origins combined with credentials.
**Prevention:** When a wildcard origin is configured and allowed, always return the static string `*` (e.g., `callback(null, '*')`) instead of dynamically returning `true`. This sets the literal `Access-Control-Allow-Origin: *` header, allowing browsers to properly reject credential-bearing requests while maintaining legitimate public API access.
