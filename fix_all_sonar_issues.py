import re
import os

def repl(f, o, n):
    with open(f, "r") as x: c = x.read()
    c = c.replace(o, n)
    with open(f, "w") as x: x.write(c)

repl("tests/cross-repo/compiled-memory-pipeline.acceptance.ts", "elapsed.length ? elapsed[elapsed.length - 1] : null", "elapsed.length ? elapsed.at(-1) : null")
repl("src/routes/authProxy.ts", "if (req.body && req.body.password) {", "if (req.body?.password) {")
repl("src/database/adapters/sqliteAdapter.ts", "...(filterBinds || {})", "...filterBinds")
repl("dashboard/src/components/MemoryTreeView.tsx", "function TreeRow({ memory }: { memory: Memory }) {", "function TreeRow({ memory }: { readonly memory: Memory }) {")
repl("dashboard/src/components/MemoryTreeView.tsx", "function MemoryTreeDiagram({ memories }: { memories: Memory[] }) {", "function MemoryTreeDiagram({ memories }: { readonly memories: Memory[] }) {")

repl("src/presentation/dreamingRoutes.ts", 'if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "event_id")) {', 'if (Object.hasOwn(req.body ?? {}, "event_id")) {')

repl("src/services/memoryGenerator.ts", "import { AnalysisResult, GraphNode } from '../types/index.js';", "import { AnalysisResult } from '../types/index.js';")

repl("dashboard/src/index.css", "transition: all 0.3s ease;", "transition: opacity 0.3s ease, transform 0.3s ease, background-color 0.3s ease;")
repl("dashboard/src/index.css", "transition: all 0.2s;", "transition: background-color 0.2s, border-color 0.2s, color 0.2s;")
repl("dashboard/src/index.css", "transition: all 0.15s ease;", "transition: transform 0.15s ease;")

repl("src/index.ts", "export { server, app, checkAuth, getStats, discoverProjects, loadAnalysis, discoverProjectsAsync, loadAnalysisAsync };", "export { server, app } from './presentation/httpServer.js';\nexport { checkAuth } from './services/authService.js';\nexport { getStats, discoverProjects, loadAnalysis, discoverProjectsAsync, loadAnalysisAsync } from './services/projectService.js';")

repl("src/services/indexingService.ts", "const funcMatch = line.match(PHP_FUNC_REGEX);", "const funcMatch = PHP_FUNC_REGEX.exec(line);")
repl("src/services/indexingService.ts", "const defMatch = line.match(PY_DEF_REGEX);", "const defMatch = PY_DEF_REGEX.exec(line);")
repl("src/services/indexingService.ts", "const clsMatch = line.match(PY_CLASS_REGEX);", "const clsMatch = PY_CLASS_REGEX.exec(line);")
repl("src/services/indexingService.ts", "const expMatch = line.match(TS_EXP_REGEX);", "const expMatch = TS_EXP_REGEX.exec(line);")
repl("src/services/indexingService.ts", "const typeMatch = line.match(TS_TYPE_REGEX);", "const typeMatch = TS_TYPE_REGEX.exec(line);")
repl("src/services/indexingService.ts", "const intMatch = line.match(TS_INT_REGEX);", "const intMatch = TS_INT_REGEX.exec(line);")
repl("src/services/indexingService.ts", "const jsFuncMatch = line.match(JS_FUNC_REGEX);", "const jsFuncMatch = JS_FUNC_REGEX.exec(line);")
repl("src/services/indexingService.ts", "const jsVarMatch = line.match(JS_VAR_REGEX);", "const jsVarMatch = JS_VAR_REGEX.exec(line);")
repl("src/services/indexingService.ts", "const jsClsMatch = line.match(JS_CLASS_REGEX);", "const jsClsMatch = JS_CLASS_REGEX.exec(line);")
repl("src/services/indexingService.ts", "const jmMatch = line.match(JAVA_METH_REGEX);", "const jmMatch = JAVA_METH_REGEX.exec(line);")
repl("src/services/indexingService.ts", "const jcMatch = line.match(JAVA_CLASS_REGEX);", "const jcMatch = JAVA_CLASS_REGEX.exec(line);")
repl("src/services/indexingService.ts", "const classMatch = line.match(PHP_CLASS_REGEX);", "const classMatch = PHP_CLASS_REGEX.exec(line);")

repl("src/services/dreamingService.ts", "static _hasContentHashColumn: boolean | null = null;", "static readonly _hasContentHashColumn: boolean | null = null;")
repl("src/services/dreamingService.ts", "static _hasTenantIdColumn: boolean | null = null;", "static readonly _hasTenantIdColumn: boolean | null = null;")

repl("src/presentation/mcpTools.ts", 'if (score) { ops.push("score"); ops.push("score_dreams"); }', 'if (score) { ops.push("score", "score_dreams"); }')
repl("src/presentation/mcpTools.ts", "maxPages: params.limit === undefined ? 3 : params.limit,", "maxPages: params.limit ?? 3,")

repl("dashboard/src/components/WikiView.tsx", "tree && tree.root && tree.root.length > 0", "tree?.root?.length > 0")

repl("src/services/memoryIngestionService.ts", r"memory.content.match(/\bfor\s+([^.!?\n]+)|(?:cho|về)\s+([^.!?\n]+)/iu)", r"/\bfor\s+([^.!?\n]+)|(?:cho|về)\s+([^.!?\n]+)/iu.exec(memory.content)")

repl("tests/cross-repo/compiled-memory-pipeline.acceptance.ts", "execFileSync('git', ['init', '--quiet', project]);", "execFileSync('git', ['init', '--quiet', project], { env: { ...process.env, PATH: '/usr/bin:/bin' } });")

# Some unused imports inside httpServer and mcpTools
repl("src/presentation/httpServer.ts", 'import { mountCronSettingsRoutes } from "./cronSettingsRoute.js";', "")

# Replace the catch block at httpServer.ts 241
# ... wait we shouldn't just replace blindly without knowing the content.
