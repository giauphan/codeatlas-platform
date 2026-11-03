import re

text = """
  [WARNING] File: src/index.ts, Line: 21
  [WARNING] File: src/services/indexingService.ts, Lines: 247-250
  [WARNING] File: src/presentation/mcpTools.ts, Line: 34
  [WARNING] File: src/services/memoryIngestionService.ts, Lines: 192-197
  [FAILURE] File: fix_typecheck.py, Line: 7
  [WARNING] File: src/services/indexingService.ts, Line: 415
  [WARNING] File: src/presentation/mcpTools.ts, Lines: 2145-2147
  [WARNING] File: src/presentation/httpServer.ts, Line: 21
  [WARNING] File: scripts/migrate-tenant.ts, Lines: 51-53
  [WARNING] File: src/presentation/httpServer.ts, Line: 18
  [WARNING] File: scripts/inspect-db.ts, Line: 40
  [WARNING] File: scripts/migrate-user.ts, Lines: 48-52
  [WARNING] File: src/presentation/httpServer.ts, Line: 1250
  [WARNING] File: dashboard/src/components/WikiView.tsx, Line: 8
  [WARNING] File: tests/cross-repo/compiled-memory-pipeline.acceptance.ts, Line: 206
  [WARNING] File: src/services/projectService.ts, Lines: 526-533
  [WARNING] File: src/presentation/httpServer.ts, Line: 1358
  [WARNING] File: src/presentation/dreamingRoutes.ts, Line: 38
  [WARNING] File: src/services/indexingService.ts, Line: 469
  [WARNING] File: dashboard/src/components/WikiView.tsx, Line: 17
  [WARNING] File: tests/cross-repo/compiled-memory-pipeline.acceptance.ts, Line: 359
  [WARNING] File: src/services/memoryIngestionService.ts, Lines: 227-231
  [WARNING] File: src/presentation/httpServer.ts, Line: 13
  [WARNING] File: src/database/adapters/sqliteAdapter.ts, Lines: 83-88
  [WARNING] File: scripts/migrate-user.ts, Line: 55
  [WARNING] File: src/services/indexingService.ts, Line: 449
  [WARNING] File: src/presentation/mcpTools.ts, Line: 10
  [WARNING] File: src/presentation/mcpTools.ts, Line: 2347
  [WARNING] File: src/services/projectService.ts, Line: 635
  [WARNING] File: dashboard/src/components/WikiView.tsx, Line: 7
"""

for line in text.strip().split("\n"):
    match = re.search(r"File: ([^,]+), (Lines?: [\d\-]+)", line)
    if match:
        file = match.group(1)
        line_num = match.group(2)
        if "-" in line_num:
            ln = int(line_num.split(" ")[1].split("-")[0])
        else:
            ln = int(line_num.split(" ")[1])
        with open(file, "r") as f:
            content = f.readlines()
        if ln <= len(content):
            print(f"{file}:{ln} - {content[ln-1].strip()}")
