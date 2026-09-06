## 2026-07-14 - [Insecure Security Context Bypass in Database Connection]
**Vulnerability:** A conditional statement in the database connection initialization code allowed bypassing Row-Level Security (RLS) based on environment variables (`CODEATLAS_BYPASS_RLS` or `NODE_ENV === 'test'`).
**Learning:** Hardcoding security bypasses, even for testing or local development, within the core production code path is extremely dangerous. It creates a critical vulnerability if those environment variables are accidentally set or misconfigured in a production environment.
**Prevention:** Do not put bypass mechanisms in production code. The best prevention is to just remove the bypass entirely, as done here, rather than trying to engineer around it. It is simpler, uses less code, and leaves no configuration surface to misconfigure. Environments that previously relied on the bypass (like dev or CI testing) will need to adjust by either ensuring a working RLS setup or using appropriate mocking.

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

## 2026-08-15 - [Arbitrary Origin Reflection in CORS Wildcard Configuration]
**Vulnerability:** The CORS configuration in `src/presentation/httpServer.ts` reflected arbitrary origins by returning `true` to the origin callback when a wildcard (`*`) was in the `ALLOWED_ORIGINS` configuration, while simultaneously setting `credentials: true`. This completely circumvents browser restrictions on cross-origin credentialed requests, allowing any external site to make authenticated requests.
**Learning:** Returning `true` to a CORS origin callback instructs the CORS middleware to echo back the requester's `Origin` header in the `Access-Control-Allow-Origin` response header. When combined with `Access-Control-Allow-Credentials: true`, this creates a severe vulnerability where credentials (like cookies or HTTP auth) are sent and accepted from any origin.
**Prevention:** When securing CORS configurations in the Express HTTP server against arbitrary origin reflection, return the static string `'*'` instead of boolean `true` when a wildcard origin is configured. This correctly sets `Access-Control-Allow-Origin: *` while allowing the browser to properly enforce credential restrictions (browsers inherently block credentialed requests to a wildcard origin), rather than breaking public non-credentialed APIs by outright rejecting them.

## 2026-08-16 - [Added Helmet middleware]
**Vulnerability:** Express app missing security headers (e.g. X-Powered-By exposed, missing XSS protection, etc.)
**Learning:** Security headers are not enabled by default in Express and must be explicitly configured using middleware like helmet. Cross-origin configuration must be considered to avoid breaking existing CORS implementations.
**Prevention:** Use helmet by default when initializing new Express applications and verify configuration against CORS needs.

## 2026-08-16 - [Overly Permissive CORS Configuration Vulnerability]
**Vulnerability:** Combining an `Access-Control-Allow-Origin: *` wildcard with `Access-Control-Allow-Credentials: true`.
**Learning:** This is rejected by browsers and inherently risky because if dynamically reflected based on request headers, it opens up a severe vulnerability where malicious sites can make credentialed requests. The codebase allowed dynamic wildcards but did not enforce setting `credentials` to `false` when wildcard origins were granted.
**Prevention:** Always use dynamic callbacks (`cors((req, callback) => ...)`) when conditional reflection of `*` is needed alongside `credentials`. Explicitly set `credentials: false` in the callback response whenever `origin` is dynamically permitted as `*`.

## 2026-08-17 - [Prevent downstream response text leakage]
**Vulnerability:** A fetch call to an external or internal microservice bubbled up the raw response text directly into the thrown Error object.
**Learning:** This is a classic Information Exposure vulnerability, as downstream APIs often return internal stack traces, container paths, or verbose context in the raw response body, which should never be exposed to users in a JSON-RPC response.
**Prevention:** Rely strictly on HTTP Status (`res.status`) and Status Text (`res.statusText`) along with the URL (`res.url`) to build informative but sanitized error strings, and explicitly avoid interpolating `res.text()` or `res.json()` directly into exception messages.

## 2026-08-25 - [Undefined Variable Reference in Security Scanner]
**Vulnerability:** The SecurityScanner was crashing with a ReferenceError (`labelLower is not defined`) because it attempted to use a variable that was not initialized in the scope when checking for SQL injection keywords.
**Learning:** Adding new heuristic string matches to security tools without running unit tests covering the specific condition can introduce critical availability bugs, crashing the security pipeline itself.
**Prevention:** Always verify that referenced variables are defined in the current scope, and ensure that new logic paths within security scanners are covered by specific unit tests before merging.

## 2026-09-06 - [Missing Tenant Isolation in Genome API]
**Vulnerability:** A `GET /api/genome/list` endpoint queried the `codeatlas_genome` table without applying a `tenant_id` filter, allowing cross-tenant data exposure (Insecure Direct Object Reference / Broken Access Control).
**Learning:** Even if data seems public or shared (like "genomes"), if the application uses a multi-tenant architecture, all database queries must explicitly scope results using the authenticated user's `tenant_id` unless intentionally designed otherwise.
**Prevention:** Always verify that a `WHERE tenant_id = :tenantId` clause (or equivalent ORM scoping) is present on all database queries returning lists of resources in multi-tenant environments.
