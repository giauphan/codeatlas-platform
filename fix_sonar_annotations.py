import re
# tests/cross-repo/compiled-memory-pipeline.acceptance.ts, Line: 113
# src/routes/authProxy.ts, Line: 99
# src/database/adapters/sqliteAdapter.ts, Line: 179
# src/presentation/httpServer.ts, Line: 193
# dashboard/src/components/MemoryTreeView.tsx, Line: 151
# src/presentation/dreamingRoutes.ts, Line: 467
# src/services/projectService.ts, Line: 635
# tests/cross-repo/compiled-memory-pipeline.acceptance.ts, Line: 206
# src/services/memoryGenerator.ts, Line: 3
# src/presentation/mcpTools.ts, Line: 711
# dashboard/src/index.css, Line: 67
# src/services/memoryIngestionService.ts, Lines: 339-343
# src/database/adapters/sqliteAdapter.ts, Line: 585
# src/services/projectService.ts, Line: 554
# src/presentation/mcpTools.ts, Line: 10
# tests/cross-repo/compiled-memory-pipeline.acceptance.ts, Line: 37
# src/index.ts, Line: 104
# src/services/indexingService.ts, Line: 495
# src/services/dreamScheduler.ts, Line: 494
# src/services/dreamingService.ts, Line: 190
# src/services/indexingService.ts, Line: 455
# src/presentation/mcpTools.ts, Line: 1835
# src/services/projectService.ts, Lines: 845-847
# src/index.ts, Line: 104
# dashboard/src/components/WikiView.tsx, Lines: 623-629
# src/services/memoryIngestionService.ts, Line: 40
# src/presentation/httpServer.ts, Line: 39
# src/presentation/mcpTools.ts, Line: 13
# src/presentation/mcpTools.ts, Line: 2354
# src/presentation/httpServer.ts, Lines: 241-243

def p(file, line):
    with open(file, "r") as f:
        lines = f.readlines()
        if line <= len(lines):
            print(f"{file}:{line} - {lines[line-1].strip()}")

p("tests/cross-repo/compiled-memory-pipeline.acceptance.ts", 113)
p("src/routes/authProxy.ts", 99)
p("src/database/adapters/sqliteAdapter.ts", 179)
p("src/presentation/httpServer.ts", 193)
p("dashboard/src/components/MemoryTreeView.tsx", 151)
p("src/presentation/dreamingRoutes.ts", 467)
p("src/services/projectService.ts", 635)
p("tests/cross-repo/compiled-memory-pipeline.acceptance.ts", 206)
p("src/services/memoryGenerator.ts", 3)
p("src/presentation/mcpTools.ts", 711)
p("dashboard/src/index.css", 67)
p("src/services/memoryIngestionService.ts", 339)
p("src/database/adapters/sqliteAdapter.ts", 585)
p("src/services/projectService.ts", 554)
p("src/presentation/mcpTools.ts", 10)
p("tests/cross-repo/compiled-memory-pipeline.acceptance.ts", 37)
p("src/index.ts", 104)
p("src/services/indexingService.ts", 495)
p("src/services/dreamScheduler.ts", 494)
p("src/services/dreamingService.ts", 190)
p("src/services/indexingService.ts", 455)
p("src/presentation/mcpTools.ts", 1835)
p("src/services/projectService.ts", 845)
p("dashboard/src/components/WikiView.tsx", 623)
p("src/services/memoryIngestionService.ts", 40)
p("src/presentation/httpServer.ts", 39)
p("src/presentation/mcpTools.ts", 13)
p("src/presentation/mcpTools.ts", 2354)
p("src/presentation/httpServer.ts", 241)
