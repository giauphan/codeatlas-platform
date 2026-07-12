# Security Scanner — Feature Documentation

## Purpose

Scan analyzed codebases for security vulnerabilities, hardcoded secrets, unsafe functions, SQL injection risks, and architectural issues. Results are scored, reported, and optionally fed into the Genome Immune System for pattern prevention.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   MCP Tool Layer                         │
│  scan_enterprise_vulnerabilities (mcpTools.ts)           │
├─────────────────────────────────────────────────────────┤
│                   SecurityScanner                         │
│  ┌──────────────┐  ┌──────────────────┐                 │
│  │ Static Scan  │  │  AI Scan (opt.)  │                 │
│  │ (patterns)   │  │  (DeepSeek V4)   │                 │
│  └──────┬───────┘  └────────┬─────────┘                 │
│         │                   │                            │
│         ▼                   ▼                            │
│  ┌─────────────────────────────────────┐                │
│  │         Security Report              │                │
│  │  CRITICAL | HIGH | MEDIUM | LOW      │                │
│  └─────────────────────────────────────┘                │
├─────────────────────────────────────────────────────────┤
│                   Data Layer                              │
│  Genome DNA (immune genes) → Oracle 26ai                 │
│  Project Analysis → File System (.codeatlas/)             │
└─────────────────────────────────────────────────────────┘
```

## Data Flow

```
1. Trigger: User calls scan_enterprise_vulnerabilities(maxProjects=10)
   ↓
2. Load: ProjectService loads analyzed projects from .codeatlas/analysis.json
   ↓
3. Static Scan: SecurityScanner.scan(analysis) → SecurityFinding[]
   ├── Hardcoded Secrets (variable name pattern matching)
   ├── Unsafe Functions (eval, exec, system, shell_exec)
   └── SQL Injection Risk (query/execute in DB context)
   ↓
4. AI Scan (optional): Findings + code context → DeepSeek V4 Pro
   └── Deeper analysis: logic bugs, arch issues, business logic flaws
   ↓
5. Report: Scored findings with severity, file path, line number, snippet
   ↓
6. Immune: Auto-generate immune genes for Genome DNA (future)
```

## API / MCP Tools

| Tool | Description |
|---|---|
| `scan_enterprise_vulnerabilities` | Scan all analyzed projects for bugs, vulns, secrets |
| `scan_immune_genes` | Check problem against known failures (Genome DNA) |

## Finding Types

| Type | Severity | Detection |
|---|---|---|
| `HARDCODED_SECRET` | HIGH | Variable name pattern (apiKey, password, token + context) |
| `UNSAFE_FUNCTION` | CRITICAL | Function name match (eval, exec, shell_exec) |
| `SQL_INJECTION_RISK` | MEDIUM | Query/execute in DB-related code (parameterized query check) |
| `LOGIC_BUG` (AI) | VARIES | DeepSeek V4 Pro analysis of code patterns |
| `ARCH_ISSUE` (AI) | VARIES | DeepSeek V4 Pro architecture smell detection |

## Extension Points

- **AI Scan**: Add `CODEATLAS_SCAN_AI_URL` env var pointing to an LLM API endpoint
- **Custom Rules**: Add patterns to `unsafeFuncs`, `dbKeywords`, `nonSecretSubstrings` arrays
- **Immune Genes**: Auto-generate prevention context from findings
- **Scoring Algorithm**: Customize severity scoring by project size/type
