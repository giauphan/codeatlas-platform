# DeepWiki Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement DeepWiki-style project wiki generation (hierarchical navigation, Markdown docs, Mermaid architecture diagrams, and Wiki Q&A) for CodeAtlas Platform.

**Architecture:** A multi-provider LLM service (`llmProviderService`) handles summarization with offline AST fallback; a `wikiService` traverses codebase graph and entities to generate hierarchical wiki pages and Mermaid diagrams; a database table `codeatlas_wiki_pages` provides persistent caching and vector indexing; REST endpoints and MCP tools expose wiki generation and Q&A; and a React `WikiView` dashboard component offers tree navigation, markdown rendering, and interactive chat.

**Tech Stack:** TypeScript, Node.js (Express), SQLite (`better-sqlite3` + `sqlite-vec`), React (Vite, TailwindCSS, Mermaid), MCP SDK.

**Spec:** `docs/superpowers/specs/2026-09-15-deepwiki-integration-design.md`

## Global Constraints
- Node.js 20+ and TypeScript ESM (`.ts` / `.js` resolution).
- SQLite-first with parameterized queries (`IDatabaseAdapter`).
- Follow Express middleware pipeline (`helmet -> cors -> compression -> auth -> routes -> error handler`).
- Test runner: `node --experimental-test-module-mocks --test-concurrency=1 --import tsx --test 'tests/**/*.test.ts'`.

---

### Task 1: Database Adapter & Schema for Wiki Pages
**Files:**
- Modify: `src/database/adapters/interface.ts`
- Modify: `src/database/adapters/sqliteAdapter.ts`
- Modify: `src/database/adapters/postgresAdapter.ts`
- Test: `tests/unit/wikiDatabase.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WikiPageRecord {
    id: string;
    project_name: string;
    path: string;
    title: string;
    summary?: string;
    content: string;
    diagram_data?: string;
    parent_path?: string;
    order_index?: number;
    created_at?: string;
    updated_at?: string;
    tenant_id?: string;
  }
  ```
  And database adapter methods:
  ```ts
  saveWikiPage(page: WikiPageRecord): Promise<void>;
  getWikiPage(projectName: string, path: string, tenantId?: string): Promise<WikiPageRecord | null>;
  listWikiPages(projectName: string, tenantId?: string): Promise<WikiPageRecord[]>;
  deleteWikiPages(projectName: string, tenantId?: string): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**
Create `tests/unit/wikiDatabase.test.ts`:
```ts
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import type { WikiPageRecord } from '../../src/database/adapters/interface.js';

describe('Wiki Database Operations', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = new SQLiteAdapter(':memory:');
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.close();
  });

  test('should save and retrieve a wiki page', async () => {
    const page: WikiPageRecord = {
      id: 'page-1',
      project_name: 'test-project',
      path: '/overview',
      title: 'Project Overview',
      summary: 'High level summary',
      content: '# Overview\nWelcome to test-project.',
      diagram_data: JSON.stringify({ nodes: [], edges: [] }),
      parent_path: '/',
      order_index: 0,
      tenant_id: 'default'
    };

    await adapter.saveWikiPage(page);
    const retrieved = await adapter.getWikiPage('test-project', '/overview', 'default');
    assert.ok(retrieved);
    assert.strictEqual(retrieved?.title, 'Project Overview');
    assert.strictEqual(retrieved?.content, '# Overview\nWelcome to test-project.');
  });

  test('should list all wiki pages for a project', async () => {
    await adapter.saveWikiPage({
      id: 'page-1',
      project_name: 'test-project',
      path: '/overview',
      title: 'Overview',
      content: 'Overview content',
      tenant_id: 'default'
    });
    await adapter.saveWikiPage({
      id: 'page-2',
      project_name: 'test-project',
      path: '/architecture',
      title: 'Architecture',
      content: 'Architecture content',
      tenant_id: 'default'
    });

    const pages = await adapter.listWikiPages('test-project', 'default');
    assert.strictEqual(pages.length, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `node --experimental-test-module-mocks --test-concurrency=1 --import tsx --test 'tests/unit/wikiDatabase.test.ts'`
Expected: FAIL (methods not defined).

- [ ] **Step 3: Implement database schema and adapter methods**
1. Add `codeatlas_wiki_pages` table creation in `SQLiteAdapter.initialize()` and `PostgresAdapter.initialize()`.
2. Add `saveWikiPage`, `getWikiPage`, `listWikiPages`, and `deleteWikiPages` to `IDatabaseAdapter` interface, `SQLiteAdapter`, and `PostgresAdapter`.

- [ ] **Step 4: Run test to verify it passes**
Run: `node --experimental-test-module-mocks --test-concurrency=1 --import tsx --test 'tests/unit/wikiDatabase.test.ts'`
Expected: PASS.

---

### Task 2: Multi-Provider LLM Service (`llmProviderService.ts`)
**Files:**
- Create: `src/services/llmProviderService.ts`
- Test: `tests/unit/llmProviderService.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LLMGenerateOptions {
    prompt: string;
    systemPrompt?: string;
    provider?: 'anthropic' | 'openai' | 'openai-compatible' | 'template';
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  }

  export class LLMProviderService {
    async generateText(options: LLMGenerateOptions): Promise<string>;
    async summarizeModule(moduleName: string, astContext: Record<string, unknown>, options?: Partial<LLMGenerateOptions>): Promise<string>;
  }
  ```

- [ ] **Step 1: Write the failing test**
Create `tests/unit/llmProviderService.test.ts`:
```ts
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { LLMProviderService } from '../../src/services/llmProviderService.js';

describe('LLMProviderService', () => {
  const service = new LLMProviderService();

  test('should generate fallback template summary when provider is template or no key', async () => {
    const summary = await service.summarizeModule('AuthService', {
      functions: ['login', 'register', 'verifyToken'],
      dependencies: ['bcrypt', 'jsonwebtoken'],
      filePath: 'src/services/authService.ts'
    }, { provider: 'template' });

    assert.ok(summary.includes('AuthService'));
    assert.ok(summary.includes('login'));
    assert.ok(summary.includes('bcrypt'));
  });

  test('should handle custom prompt generation with template fallback', async () => {
    const result = await service.generateText({
      prompt: 'Explain what this module does: functions=[a, b]',
      provider: 'template'
    });
    assert.ok(result.length > 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `node --experimental-test-module-mocks --test-concurrency=1 --import tsx --test 'tests/unit/llmProviderService.test.ts'`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `LLMProviderService`**
Implement Anthropic Claude, OpenAI, OpenAI-compatible HTTP fetch calls, plus the offline structured template generator.

- [ ] **Step 4: Run test to verify it passes**
Run: `node --experimental-test-module-mocks --test-concurrency=1 --import tsx --test 'tests/unit/llmProviderService.test.ts'`
Expected: PASS.

---

### Task 3: Wiki Generator & Core Service (`wikiService.ts`)
**Files:**
- Create: `src/services/wikiService.ts`
- Test: `tests/unit/wikiService.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WikiNode {
    path: string;
    title: string;
    summary?: string;
    children?: WikiNode[];
  }

  export interface WikiTreeResponse {
    projectName: string;
    root: WikiNode[];
    totalPages: number;
    lastGeneratedAt?: string;
  }

  export class WikiService {
    constructor(dbAdapter: IDatabaseAdapter, llmProvider?: LLMProviderService);
    async generateProjectWiki(projectName: string, options?: { provider?: string; apiKey?: string; baseUrl?: string; model?: string; exportToDisk?: boolean }): Promise<WikiTreeResponse>;
    async getWikiTree(projectName: string): Promise<WikiTreeResponse>;
    async getWikiPage(projectName: string, path: string): Promise<WikiPageRecord | null>;
    async queryWiki(projectName: string, query: string): Promise<{ answer: string; references: string[] }>;
  }
  ```

- [ ] **Step 1: Write the failing test**
Create `tests/unit/wikiService.test.ts`:
```ts
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { WikiService } from '../../src/services/wikiService.js';
import { LLMProviderService } from '../../src/services/llmProviderService.js';

describe('WikiService', () => {
  let adapter: SQLiteAdapter;
  let service: WikiService;

  beforeEach(async () => {
    adapter = new SQLiteAdapter(':memory:');
    await adapter.initialize();
    service = new WikiService(adapter, new LLMProviderService());
  });

  afterEach(async () => {
    await adapter.close();
  });

  test('should generate full wiki structure for a project with overview, architecture, and module pages', async () => {
    const result = await service.generateProjectWiki('sample-app', { provider: 'template' });
    assert.ok(result);
    assert.strictEqual(result.projectName, 'sample-app');
    assert.ok(result.totalPages >= 3);

    const overviewPage = await service.getWikiPage('sample-app', '/overview');
    assert.ok(overviewPage);
    assert.ok(overviewPage?.content.includes('Overview'));

    const archPage = await service.getWikiPage('sample-app', '/architecture');
    assert.ok(archPage);
    assert.ok(archPage?.content.includes('mermaid'));
  });

  test('should query wiki and return relevant answer and references', async () => {
    await service.generateProjectWiki('sample-app', { provider: 'template' });
    const response = await service.queryWiki('sample-app', 'What does this project do?');
    assert.ok(response.answer);
    assert.ok(Array.isArray(response.references));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `node --experimental-test-module-mocks --test-concurrency=1 --import tsx --test 'tests/unit/wikiService.test.ts'`
Expected: FAIL.

- [ ] **Step 3: Implement `WikiService`**
Implement graph traversal, AST entity grouping by folder/module, Mermaid flowchart generator, page persistence, tree builder, and wiki Q&A query engine.

- [ ] **Step 4: Run test to verify it passes**
Run: `node --experimental-test-module-mocks --test-concurrency=1 --import tsx --test 'tests/unit/wikiService.test.ts'`
Expected: PASS.

---

### Task 4: REST API Endpoints (`src/presentation/routes/wikiRoutes.ts`)
**Files:**
- Create: `src/presentation/routes/wikiRoutes.ts`
- Modify: `src/presentation/httpServer.ts`
- Test: `tests/integration/wikiRoutes.test.ts`

**Endpoints:**
- `POST /api/wiki/:project/generate`
- `GET /api/wiki/:project/tree`
- `GET /api/wiki/:project/page`
- `POST /api/wiki/:project/query`

- [ ] **Step 1: Write integration tests**
Create `tests/integration/wikiRoutes.test.ts`.

- [ ] **Step 2: Run test to verify it fails**
Run: `node --experimental-test-module-mocks --test-concurrency=1 --import tsx --test 'tests/integration/wikiRoutes.test.ts'`
Expected: FAIL.

- [ ] **Step 3: Implement route handlers and mount to Express in `httpServer.ts`**
Add router in `src/presentation/routes/wikiRoutes.ts` and mount at `/api/wiki`.

- [ ] **Step 4: Run test to verify it passes**
Run: `node --experimental-test-module-mocks --test-concurrency=1 --import tsx --test 'tests/integration/wikiRoutes.test.ts'`
Expected: PASS.

---

### Task 5: MCP Server Tools for DeepWiki (`src/presentation/mcpTools.ts`)
**Files:**
- Modify: `src/presentation/mcpTools.ts`
- Test: `tests/unit/wikiMcpTools.test.ts`

**Tools to add:**
- `generate_project_wiki`
- `get_wiki_page`
- `query_project_wiki`

- [ ] **Step 1: Write unit tests for MCP tools**
Create `tests/unit/wikiMcpTools.test.ts`.

- [ ] **Step 2: Run test to verify failure**
Run: `node --experimental-test-module-mocks --test-concurrency=1 --import tsx --test 'tests/unit/wikiMcpTools.test.ts'`

- [ ] **Step 3: Add MCP tool definitions and execution handlers**

- [ ] **Step 4: Run test to verify it passes**
Run: `node --experimental-test-module-mocks --test-concurrency=1 --import tsx --test 'tests/unit/wikiMcpTools.test.ts'`

---

### Task 6: Dashboard UI — `WikiView.tsx` & Navigation
**Files:**
- Create: `dashboard/src/pages/WikiView.tsx`
- Modify: `dashboard/src/App.tsx` (or dashboard router)

**Features:**
- Sidebar tree navigator for wiki pages.
- Markdown viewer with syntax highlighting and Mermaid diagram rendering.
- "Generate / Rebuild Wiki" button with provider dialog.
- Interactive Wiki Q&A drawer.

- [ ] **Step 1: Implement `WikiView.tsx` component and register in dashboard router**
- [ ] **Step 2: Run frontend build or typecheck to ensure no regressions**

---

### Task 7: Verification & Final Diff Review
- [ ] **Step 1: Run full test suite**
Run: `pnpm test`
- [ ] **Step 2: Run TypeScript typecheck & build**
Run: `pnpm run typecheck && pnpm run build`
- [ ] **Step 3: Review diff and call `sync_system_memory`**
