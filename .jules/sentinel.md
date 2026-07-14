## 2026-07-14 - SQL Injection Risk in GenomeService
**Vulnerability:** A SQL Injection risk was found in `src/services/genomeService.ts` where arrays were joined directly into SQL update query strings without sanitization.
**Learning:** Using dynamic arrays to construct SQL queries is prone to SQL Injection if not carefully validated.
**Prevention:** Explicitly filter update strings against a strict allowlist.
