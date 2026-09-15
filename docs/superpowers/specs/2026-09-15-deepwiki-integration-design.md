# DeepWiki Integration Design Specification

## 1. Overview
This specification details the architecture for adding DeepWiki-style automated documentation and project wiki generation to the CodeAtlas Platform (inspired by [Devin DeepWiki](https://docs.devin.ai/work-with-devin/deepwiki)).

CodeAtlas currently analyzes AST, entities, and dependency graphs. This feature synthesizes that graph intelligence into comprehensive, structured project wikis with interactive architecture diagrams, module deep-dives, navigation trees, and conversational Q&A.

---

## 2. Architecture & Data Flow

```
+-------------------------------------------------------------------------------+
|                             Presentation Layer                                |
|  - REST API: /api/wiki/:project/*                                             |
|  - MCP Server Tools: generate_project_wiki, get_wiki_page, query_project_wiki  |
|  - Dashboard: WikiView.tsx (Tree Nav, Markdown + Mermaid Viewer, Q&A Panel)  |
|  - CLI: `codeatlas wiki [project]`                                            |
+---------------------------------------+---------------------------------------+
                                        |
                                        v
+---------------------------------------+---------------------------------------+
|                                Service Layer                                  |
|  - wikiService.ts: Coordinates wiki generation, tree building, indexing       |
|  - llmProviderService.ts: Multi-provider LLM connector (Anthropic, OpenAI,    |
|                           custom endpoints, and offline AST fallback)         |
|  - diagramGenerator.ts: Generates Mermaid system flows and sequence charts    |
+---------------------------------------+---------------------------------------+
                                        |
                                        v
+---------------------------------------+---------------------------------------+
|                       Persistence & Knowledge Graph                           |
|  - DB Table: codeatlas_wiki_pages (SQLite & Postgres adapters)                |
|  - DB Table: codeatlas_llm_configs                                            |
|  - File Export: .codeatlas/wiki/*.md (optional export on disk)                |
|  - Existing CodeAtlas Graph: AnalysisResult, Entities, Dependencies           |
+-------------------------------------------------------------------------------+
```

---

## 3. Data Models

### 3.1 `codeatlas_wiki_pages`
Stores individual generated wiki pages for fast retrieval and vector indexing.

```sql
CREATE TABLE IF NOT EXISTS codeatlas_wiki_pages (
    id TEXT PRIMARY KEY,
    project_name TEXT NOT NULL,
    path TEXT NOT NULL,                  -- e.g., "/", "/src/services", "/api-reference"
    title TEXT NOT NULL,                 -- e.g., "Overview", "Services Layer", "Authentication"
    summary TEXT,
    content TEXT NOT NULL,               -- Full Markdown with Mermaid blocks
    diagram_data TEXT,                   -- Optional JSON structured diagram metadata
    parent_path TEXT,
    order_index INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    tenant_id TEXT DEFAULT 'default'
);

CREATE INDEX IF NOT EXISTS idx_wiki_pages_project_path ON codeatlas_wiki_pages(project_name, path);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_tenant ON codeatlas_wiki_pages(tenant_id);
```

### 3.2 `codeatlas_llm_configs`
Stores user-configured LLM providers for wiki generation and chat.

```sql
CREATE TABLE IF NOT EXISTS codeatlas_llm_configs (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,             -- 'anthropic', 'openai', 'openai-compatible', 'mock'
    api_key TEXT,
    base_url TEXT,
    model TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    tenant_id TEXT DEFAULT 'default',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 4. Components & Implementation Details

### 4.1 `llmProviderService.ts`
- Supports Anthropic Claude (using official SDK / REST), OpenAI (using official SDK / REST), OpenAI-compatible custom endpoints (Ollama, vLLM, DeepSeek, LocalAI), and an offline Template Fallback generator that synthesizes AST metadata without external API calls.

### 4.2 `wikiService.ts`
- **`generateProjectWiki(projectName, options)`**:
  1. Inspects codebase structure, folders, modules, and entrypoints.
  2. Builds hierarchical wiki tree:
     - `Overview.md` (Executive summary, tech stack, key components).
     - `Architecture.md` (System flowchart, component relationships via Mermaid).
     - Module pages (e.g. `services.md`, `repositories.md`, `presentation.md` with call graphs and exported symbols).
     - `ApiReference.md` (REST endpoints, MCP tools catalog).
  3. Uses LLM to summarize purpose, invariants, and workflows for each module, passing structured AST & dependency context.
  4. Saves results in `codeatlas_wiki_pages` and optionally writes `.codeatlas/wiki/`.
- **`getWikiTree(projectName)`**: Returns nested page tree hierarchy.
- **`getWikiPage(projectName, path)`**: Returns markdown and diagram details.
- **`queryWiki(projectName, query)`**: Searches wiki pages and knowledge graph, synthesizing an answer with citations.

### 4.3 REST Endpoints (`src/presentation/routes/wikiRoutes.ts`)
- `POST /api/wiki/:project/generate` — Start wiki generation.
- `GET /api/wiki/:project/tree` — Get navigation tree.
- `GET /api/wiki/:project/page` — Get page content by path.
- `POST /api/wiki/:project/query` — Interactive Q&A chat.
- `GET /api/wiki/config` & `POST /api/wiki/config` — Manage LLM provider configuration.

### 4.4 MCP Server Tools (`src/presentation/mcpTools.ts`)
- `generate_project_wiki`: Arguments: `project` (string), `provider` (optional), `model` (optional).
- `get_wiki_page`: Arguments: `project` (string), `path` (string).
- `query_project_wiki`: Arguments: `project` (string), `query` (string).

### 4.5 Dashboard UI (`dashboard/src/pages/WikiView.tsx`)
- Tree navigation sidebar reflecting project directories and module pages.
- Markdown renderer supporting GFM tables, code blocks, and embedded Mermaid diagrams (````mermaid`).
- Top action bar with "Generate / Rebuild Wiki" and LLM Settings.
- Ask Wiki / Q&A conversational drawer with citations and link back to code.

### 4.6 CLI Integration
- CLI command `codeatlas wiki [project]` to generate or serve wiki.

---

## 5. Testing & Verification Strategy
1. **Unit tests (`tests/unit/wikiService.test.ts`)**:
   - Test wiki tree generation, markdown formatting, diagram inclusion, and offline template fallback.
2. **Integration tests (`tests/integration/wikiRoutes.test.ts`)**:
   - Test REST endpoints (`POST /api/wiki/:project/generate`, `GET /api/wiki/:project/tree`, `GET /api/wiki/:project/page`, `POST /api/wiki/:project/query`).
3. **MCP Tool tests (`tests/unit/wikiMcpTools.test.ts`)**:
   - Verify tool definitions and execution handlers.
4. **Build & Typecheck**:
   - `pnpm run typecheck` and `pnpm run build` must pass cleanly.
