# API usage examples

These examples exercise the public REST API and MCP endpoints against a local server. Start the server with `PORT=3381 pnpm start` and use `http://127.0.0.1:3381` as the base URL.

The generated OpenAPI document remains the source of truth for all request and response schemas. This page captures the most common flows.

## Authentication

All API requests require authentication via either:

- `x-api-key` header (API key set via `CODEATLAS_API_KEY`), or
- `Authorization: Bearer <firebase-token>` header (Firebase ID token).

```bash
API_KEY="your_api_key"
BASE_URL="http://127.0.0.1:3381"
```

## Health check

```bash
curl "$BASE_URL/health"
```

Example response:

```json
{
  "status": "ok",
  "timestamp": "2026-08-14T05:00:00.000Z"
}
```

## Save a dream memory

```bash
curl --request POST "$BASE_URL/api/dreams/save" \
  --header "x-api-key: $API_KEY" \
  --header "Content-Type: application/json" \
  --data '{
    "memory_type": "KNOWLEDGE",
    "content": "Oracle 26ai MERGE requires TO_CLOB() when COALESCE-ing a VARCHAR2 bind with a CLOB column to avoid ORA-00932.",
    "importance": 7,
    "project": "codeatlas-platform",
    "scope": "db/oracle",
    "tags": ["oracle", "clob", "merge"],
    "related_ids": ["dream-123"]
  }'
```

Example response:

```json
{
  "success": true,
  "id": "codeatlas-platform_KNOWLEDGE_session-1_1719...",
  "memory_type": "KNOWLEDGE"
}
```

### Memory types

| Type | When to use |
|---|---|
| `MISTAKE` | What went wrong and the fix |
| `PREFERENCE` | How to do things |
| `KNOWLEDGE` | What was learned |
| `PATTERN` | Reusable pattern |
| `SESSION_SUMMARY` | End-of-session summary for cross-session context |

### Validation

- `content`: non-empty string, must pass noise gate (~40 chars minimum).
- `scope`: optional, regex `^[a-z0-9][a-z0-9/-]{0,499}$` (e.g., `auth/login`).
- `tags`: optional array of strings, max 100 items, 100 chars each.
- `related_ids`: optional array of strings, max 100 items, 100 chars each.

## Save a session summary

```bash
curl --request POST "$BASE_URL/api/dreams/save" \
  --header "x-api-key: $API_KEY" \
  --header "Content-Type: application/json" \
  --data '{
    "memory_type": "SESSION_SUMMARY",
    "content": "Implemented context retention across sessions: added scope, tags, related_ids metadata to ai_dreaming_memory in Oracle 26ai. Updated MCP server schemas and brain-context.sh hook to auto-load latest SESSION_SUMMARY.",
    "importance": 8,
    "project": "codeatlas-platform",
    "scope": "memory/session-summary"
  }'
```

## Query dream memories

### Semantic search

```bash
curl "$BASE_URL/api/dreams/query?project=codeatlas-platform&query=oracle%20clob&limit=5" \
  --header "x-api-key: $API_KEY"
```

Example response:

```json
{
  "memories": [
    {
      "id": "codeatlas-platform_KNOWLEDGE_...",
      "memory_type": "KNOWLEDGE",
      "content": "Oracle 26ai MERGE requires TO_CLOB()...",
      "importance": 7,
      "scope": "db/oracle",
      "tags": ["oracle", "clob", "merge"],
      "related_ids": ["dream-123"],
      "created_at": "2026-08-14T05:00:00.000Z"
    }
  ],
  "count": 1
}
```

### Filter by scope (hierarchical)

Scope matching is hierarchical: `scope=auth` matches `auth`, `auth/login`, `auth/login/jwt`, etc.

```bash
curl "$BASE_URL/api/dreams/query?project=codeatlas-platform&scope=auth&limit=10" \
  --header "x-api-key: $API_KEY"
```

### Filter by memory type

```bash
curl "$BASE_URL/api/dreams/query?project=codeatlas-platform&memory_type=SESSION_SUMMARY&limit=1" \
  --header "x-api-key: $API_KEY"
```

### Filter by tags

Tags can be a comma-separated string or JSON array:

```bash
curl "$BASE_URL/api/dreams/query?project=codeatlas-platform&tags=jwt,security&limit=10" \
  --header "x-api-key: $API_KEY"
```

### Pagination

```bash
curl "$BASE_URL/api/dreams/query?project=codeatlas-platform&query=auth&limit=10&offset=20" \
  --header "x-api-key: $API_KEY"
```

## Delete a dream memory

```bash
curl --request DELETE "$BASE_URL/api/dreams/delete?id=dream-123" \
  --header "x-api-key: $API_KEY"
```

## MCP integration

### Claude Desktop (stdio)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "codeatlas": {
      "command": "npx",
      "args": ["-y", "codeatlas-ai"],
      "env": {
        "CODEATLAS_API_KEY": "your_api_key"
      }
    }
  }
}
```

### Cursor / VSCode (SSE)

```json
{
  "mcpServers": {
    "codeatlas": {
      "url": "http://localhost:3381/sse"
    }
  }
}
```

### Transport modes

| Mode | When | Endpoint |
|---|---|---|
| **stdio** | `PORT` not set | stdin/stdout (Claude Desktop) |
| **SSE** | `PORT=3381` | `:3381/sse` + `:3381/messages` |

## REST endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check |
| `/sse` | GET | SSE endpoint for MCP |
| `/messages` | POST | Message endpoint for MCP |
| `/api/projects` | GET | List projects |
| `/api/projects/sync` | POST | Sync analysis data |
| `/api/analysis` | GET | Get analysis data |
| `/api/projects/settings` | GET/POST | Project settings |
| `/api/dreams/save` | POST | Save a dream memory |
| `/api/dreams/query` | GET | Query dream memories |
| `/api/dreams/delete` | DELETE | Delete a dream memory |
| `/api/dreams/ingest-session` | POST | Ingest conversation transcript |
| `/api/dreams/generate-daily-dreams` | POST | Trigger daily consolidation |

## Error response conventions

Client errors return JSON with an `error` field:

```json
{
  "error": "Invalid memory_type. Must be one of: MISTAKE, PREFERENCE, KNOWLEDGE, PATTERN, SESSION_SUMMARY"
}
```

| Status | When |
|---|---|
| 400 | Invalid request body or params |
| 401 | Missing or invalid API key / Bearer token |
| 404 | Resource not found |
| 500 | Server error (logged via `logger.error`) |

## PowerShell authentication flow

```powershell
$baseUrl = "http://127.0.0.1:3381"
$apiKey = "your_api_key"
$headers = @{ "x-api-key" = $apiKey }

$body = @{
  memory_type = "KNOWLEDGE"
  content = "PowerShell example for saving a dream memory"
  importance = 5
  project = "codeatlas-platform"
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "$baseUrl/api/dreams/save" `
  -Headers $headers -ContentType "application/json" -Body $body
```
