import re
import os

def p(file, line):
    with open(file, "r") as f:
        lines = f.readlines()
        if line <= len(lines):
            print(f"{file}:{line} - {lines[line-1].strip()}")
def repl(f, o, n):
    with open(f, "r") as x: c = x.read()
    c = c.replace(o, n)
    with open(f, "w") as x: x.write(c)

repl("src/presentation/mcpTools.ts", 'const linksBySource = new Map<string, Array<{ to: string; type: string }>>();', 'const linksBySource = new Map<string, Array<{ readonly to: string; readonly type: string }>>();')
repl("src/presentation/mcpTools.ts", "} from \"../services/projectService.js\";", "  fileExists,\n} from \"../services/projectService.js\";")
repl("dashboard/src/index.css", "transition: all 0.3s ease;", "transition: opacity 0.3s ease, transform 0.3s ease, background-color 0.3s ease;")
repl("src/presentation/httpServer.ts", "import { mountCronSettingsRoutes } from \"./cronSettingsRoute.js\";", "")
repl("src/index.ts", "export { server, app, checkAuth, getStats, discoverProjects, loadAnalysis, discoverProjectsAsync, loadAnalysisAsync };", "export { server, app } from './presentation/httpServer.js';\nexport { checkAuth } from './services/authService.js';\nexport { getStats, discoverProjects, loadAnalysis, discoverProjectsAsync, loadAnalysisAsync } from './services/projectService.js';")
repl("dashboard/src/components/WikiView.tsx", "const match = part.match(/^```([a-zA-Z]*)\\n([\\s\\S]*?)\\n```$/);", "const match = /^```([a-zA-Z]*)\\n([\\s\\S]*?)\\n```$/.exec(part);")
repl("tests/cross-repo/compiled-memory-pipeline.acceptance.ts", "execFileSync('git', ['init', '--quiet', project]);", "execFileSync('git', ['init', '--quiet', project], { env: { ...process.env, PATH: '/usr/bin:/bin' } });")
repl("src/presentation/mcpTools.ts", "import * as fs from \"node:fs\";", "")
repl("dashboard/src/components/WikiView.tsx", "import { FileText, Folder, FolderOpen, BookOpen, Clock, Tag, ChevronDown, ChevronRight, Hash, Code, LayoutTemplate, HelpCircle, CheckCircle, Search, Terminal, AlertCircle } from 'lucide-react';", "import { FileText, Folder, FolderOpen, BookOpen, Clock, Tag, Hash, LayoutTemplate, Search, Terminal, AlertCircle } from 'lucide-react';")
repl("src/presentation/mcpTools.ts", 'if (score) { ops.push("score"); ops.push("score_dreams"); }', 'if (score) { ops.push("score", "score_dreams"); }')
repl("src/presentation/mcpTools.ts", "maxPages: params.limit === undefined ? 3 : params.limit,", "maxPages: params.limit ?? 3,")
repl("src/services/memoryIngestionService.ts", "await createDatabaseAdapter().execute(", "void createDatabaseAdapter().execute(")
repl("src/presentation/dreamingRoutes.ts", "import { DreamingService, DreamMemoryType } from \"../services/dreamingService.js\";", "import { DreamingService } from \"../services/dreamingService.js\";")
repl("tests/cross-repo/compiled-memory-pipeline.acceptance.ts", "assert.equal((await captureRows(sessionId)).length, 0, 'Zero events should be captured when telemetry disabled');", "assert.equal((await captureRows(sessionId)).length, 0, 'Zero events should be captured when telemetry disabled');") # not a real fix
repl("src/presentation/httpServer.ts", "return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';", "return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';") # What is the issue here?
repl("src/services/dreamingService.ts", "static _hasContentHashColumn: boolean | null = null;", "static readonly _hasContentHashColumn: boolean | null = null;")
repl("src/presentation/mcpTools.ts", "import { DreamingService, DreamMemoryType } from \"../services/dreamingService.js\";", "import { DreamingService } from \"../services/dreamingService.js\";")
repl("src/presentation/httpServer.ts", "} catch (err) {\n      next(err);\n    }", "} catch (err) {\n      if (err instanceof Error) next(err); else next(new Error(String(err)));\n    }")
