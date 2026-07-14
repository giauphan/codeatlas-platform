## 2026-07-14 - Fix Insecure Random UUID Generation
**Vulnerability:** The frontend was generating API keys using `crypto.randomUUID()`.
**Learning:** While UUIDv4 generates pseudo-random numbers, its entropy is limited to 122 bits and its structure makes it predictable compared to true cryptographic random generators. Generating high-security API keys on the frontend is generally risky, but if it must be done, it requires sufficient entropy using a CSPRNG.
**Prevention:** Always use `crypto.getRandomValues()` with an array of at least 32 bytes (256 bits) of entropy when generating API keys, secrets, or enterprise-level identifiers on the client side. Never rely on UUID generators for cryptographic secrets.
