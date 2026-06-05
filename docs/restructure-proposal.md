# CodeAtlas — Restructure Proposal

## Mục tiêu

- Dễ bảo trì: mỗi file có 1 responsibility rõ ràng
- Dễ mở rộng: thêm feature mới không cần đụng file cũ
- Clean Architecture: domain logic tách biệt khỏi framework/presentation

---

## 1. File Mapping Chi Tiết

### src/ — Core Source

| File hiện tại | LOC | Vấn đề | File mới | Ghi chú |
|---|---|---|---|---|
| **Root** | | | |
| `index.ts` | ~50 | Sai vị trí | `src/index.ts` | Entry point |
| | | | `src/app.ts` | Express app setup |
| **Mixed responsibility** | | | |
| `oracleDatabase.ts` | 650 | 3 responsibilities: pool init, memory CRUD, embeddings | `src/database/connection.ts` | Pool init & lifecycle |
| | | | `src/services/memoryService.ts` | Episodic + semantic memory |
| | | | `src/services/embeddingService.ts` | NVIDIA embedding API |
| `repositories.ts` | 186 | Interface + implementation cùng file | `src/repositories/index.ts` | Interface definitions |
| | | | `src/repositories/firestoreRepository.ts` | Firestore implementation |
| `projectService.ts` | 758 | Quá lớn, gồm discovery + registry + analysis | `src/services/projectService.ts` | Giữ nhưng tách registry |
| | | | `src/repositories/projectRegistry.ts` | File JSON registry |
| **Orphan files** | | | |
| `context.ts` | 11 | Auth context không rõ module | `src/utils/context.ts` | Chuyển vào utils |
| `logger.ts` | 95 | Utility | `src/utils/logger.ts` | Chuyển vào utils |
| `types.ts` | 84 | Shared types | `src/types/index.ts` | Merge với services/types.ts |
| `services/types.ts` | 48 | Duplicate types | → `src/types/index.ts` | Merge |
| `memoryGenerator.ts` | 301 | Service | `src/services/memoryGenerator.ts` | Cùng folder với services |
| `securityScanner.ts` | 171 | Scanner | `src/services/scanner/securityScanner.ts` | Sub-folder scanner |
| `oracleSchema.sql` | — | DDL reference | `src/database/schema.sql` | Move vào database/ |
| **Presentation** | | | |
| `httpServer.ts` | 1005 | Auth middleware lẫn trong HTTP | `src/presentation/httpServer.ts` | Giữ, extract middleware riêng |
| | | | `src/middleware/auth.ts` | Auth middleware (mới) |
| `mcpServer.ts` | 19 | MCP setup | `src/presentation/mcpServer.ts` | Keep |
| `mcpTools.ts` | 1160 | MCP tools | `src/presentation/mcpTools.ts` | Keep |
| **Config** | | | |
| — | | Thiếu config module | `src/config/env.ts` | Load + validate env vars |
| **Domain (optional)** | | | |
| — | | Thiếu use cases | `src/domain/usecases/` | Clean Architecture (optional) |

### tests/ — Tests

| Hiện tại | → Mới |
|---|---|
| `tests/api.test.ts` | `tests/integration/api.test.ts` |
| `tests/oracleDatabase.test.ts` | `tests/integration/database.test.ts` |
| `tests/settings.test.ts` | `tests/integration/settings.test.ts` |
| `tests/autoScanIntegration.test.ts` | `tests/e2e/scan-flow.test.ts` |
| `tests/projectDeletion.test.ts` | `tests/integration/project-deletion.test.ts` |
| `tests/saasMultiTenant.test.ts` | `tests/integration/multi-tenant.test.ts` |
| `tests/mcp.test.ts` | `tests/integration/mcp.test.ts` |
| `tests/watcher.test.ts` | `tests/integration/watcher.test.ts` |
| `tests/securityScanner.test.ts` | `tests/unit/scanner.test.ts` |
| `tests/memoryGenerator.test.ts` | `tests/unit/memory-generator.test.ts` |
| `tests/repositories.test.ts` | `tests/unit/repositories.test.ts` |
| `tests/projectDiscoveryHardening.test.ts` | `tests/integration/discovery.test.ts` |

### scripts/ & other

| Hiện tại | → Mới |
|---|---|
| `scripts/db-init.ts` | Keep |
| `scratch/*` (10+ files) | **Xoá** — không cần thiết |
| `pr_description.md` | **Xoá** — temp |
| `submit.sh` | **Xoá** — temp |
| `test_parse.js` | **Xoá** — temp |
| `projects/` | **Xoá** — empty |
| — | `docs/architecture.md` | Architecture diagram mới |
| — | `docs/db-schema.md` | Database schema doc |

---

## 2. Cấu trúc mới (Full Tree)

```
codeatlas/
├── src/
│   ├── index.ts                 # Entry point (moved from root)
│   ├── app.ts                   # Express app setup
│   ├── config/
│   │   └── env.ts               # Env validation
│   ├── types/
│   │   ├── index.ts             # Shared types (merge types.ts + services/types.ts)
│   │   ├── express.d.ts
│   │   └── mcp.ts               # MCP-specific types
│   ├── utils/
│   │   ├── logger.ts
│   │   └── context.ts           # AuthContext + authStorage
│   ├── middleware/
│   │   └── auth.ts              # Auth middleware (extracted from httpServer.ts)
│   ├── database/
│   │   ├── connection.ts        # Oracle pool init & lifecycle
│   │   └── schema.sql           # Reference DDL
│   ├── services/
│   │   ├── authService.ts       # Auth logic
│   │   ├── projectService.ts    # Project discovery + analysis loading (split registry → repo)
│   │   ├── memoryService.ts     # Episodic + semantic memory CRUD (from oracleDatabase.ts)
│   │   ├── embeddingService.ts  # NVIDIA embedding API calls (from oracleDatabase.ts)
│   │   ├── memoryGenerator.ts   # .agents/memory/ generation
│   │   └── scanner/
│   │       └── securityScanner.ts
│   ├── repositories/
│   │   ├── index.ts             # Repository interfaces
│   │   ├── firestoreRepository.ts
│   │   └── projectRegistry.ts   # File-based registered_projects.json
│   ├── domain/
│   │   └── usecases/
│   │       └── authenticateKey.ts
│   └── presentation/
│       ├── httpServer.ts        # Express HTTP + SSE endpoints
│       ├── mcpServer.ts         # MCP server setup
│       └── mcpTools.ts          # MCP tool definitions
├── tests/
│   ├── unit/
│   │   ├── scanner.test.ts
│   │   ├── memory-generator.test.ts
│   │   └── repositories.test.ts
│   ├── integration/
│   │   ├── api.test.ts
│   │   ├── database.test.ts
│   │   ├── settings.test.ts
│   │   ├── project-deletion.test.ts
│   │   ├── multi-tenant.test.ts
│   │   ├── mcp.test.ts
│   │   ├── watcher.test.ts
│   │   └── discovery.test.ts
│   └── e2e/
│       └── scan-flow.test.ts
├── scripts/
│   └── db-init.ts               # DB migration (keep)
├── docs/
│   ├── architecture.md
│   └── db-schema.md
├── instantclient/               # Oracle libs (keep)
├── wallet/                      # Oracle wallet (keep)
├── dashboard/                   # React app (keep, separate)
├── .github/workflows/
│   ├── ci.yml
│   └── cd.yml
├── .env.example
├── CLAUDE.md
├── tsconfig.json
├── package.json
└── README.md
```

---

## 3. Ưu điểm

| **Trước** | **Sau** |
|---|---|
| `oracleDatabase.ts`: 650 LOC, 3 responsibilities | `database/connection.ts` (100 LOC) + `services/memoryService.ts` (300 LOC) + `services/embeddingService.ts` (150 LOC) |
| `repositories.ts`: interface + impl lộn xộn | `repositories/` folder, interface tách biệt implementation |
| `projectService.ts`: 758 LOC, vừa registry vừa service | Registry → `repositories/projectRegistry.ts`, service giảm 50% |
| Tests flat: 12 file cùng cấp | Phân loại: unit (3) / integration (8) / e2e (1) |
| `scratch/`, `projects/`, `submit.sh`, `pr_description.md` | Dọn sạch |
| Không config module | `config/env.ts` — 1 nơi validate env |
| Auth middleware trong httpServer.ts | Tách `middleware/auth.ts` riêng |

## 4. Rủi ro & Mitigation

| Rủi ro | Giải pháp |
|---|---|
| Import paths thay đổi | Dùng path alias `@/` trong tsconfig.json |
| Test imports sai | Update từng file, chạy `tsc --noEmit` verify |
| oracleDatabase.ts split sai | Giữ nguyên logic, chỉ refactor từng hàm 1 |
| Git history mất | `git mv` thay vì copy-delete |
