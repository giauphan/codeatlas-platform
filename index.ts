#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

interface GraphNode {
  id: string;
  label: string;
  type: string;
  color?: string;
  filePath?: string;
  line?: number;
  val?: number;
}

interface GraphLink {
  source: string;
  target: string;
  type: string;
  label?: string;
}

interface AnalysisResult {
  graph: { nodes: GraphNode[]; links: GraphLink[] };
  insights: any[];
  stats?: { files: number; functions: number; classes: number; dependencies: number; circularDeps: number };
  entityCounts?: { modules: number; functions: number; classes: number; dependencies: number; circularDeps: number };
  totalFilesAnalyzed?: number;
  totalFilesSkipped?: number;
}

/** Helper: get unified stats from analysis (handles both old and new format) */
function getStats(analysis: AnalysisResult) {
  const ec = analysis.entityCounts;
  const st = analysis.stats;
  return {
    files: st?.files ?? ec?.modules ?? analysis.totalFilesAnalyzed ?? 0,
    modules: ec?.modules ?? st?.files ?? analysis.totalFilesAnalyzed ?? 0,
    functions: ec?.functions ?? st?.functions ?? 0,
    classes: ec?.classes ?? st?.classes ?? 0,
    dependencies: ec?.dependencies ?? st?.dependencies ?? 0,
    circularDeps: ec?.circularDeps ?? st?.circularDeps ?? 0,
  };
}

// Auto-discover all projects with .codeatlas/analysis.json
function discoverProjects(): { name: string; dir: string; analysisPath: string; modifiedAt: Date }[] {
  const projects: { name: string; dir: string; analysisPath: string; modifiedAt: Date }[] = [];
  const homeDir = process.env.HOME || process.env.USERPROFILE || "/home";

  // Scan directories for .codeatlas/analysis.json
  const searchDirs: string[] = [];

  // Add env var project if specified
  if (process.env.CODEATLAS_PROJECT_DIR) {
    searchDirs.push(process.env.CODEATLAS_PROJECT_DIR);
  }

  // Add cwd
  searchDirs.push(process.cwd());

  // Scan home directory children (max depth 2)
  try {
    const homeDirs = fs.readdirSync(homeDir);
    for (const d of homeDirs) {
      if (d.startsWith(".")) continue;
      const fullPath = path.join(homeDir, d);
      try {
        if (fs.statSync(fullPath).isDirectory()) {
          searchDirs.push(fullPath);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  // Check each directory for .codeatlas/analysis.json
  const seen = new Set<string>();
  for (const dir of searchDirs) {
    const analysisPath = path.join(dir, ".codeatlas", "analysis.json");
    if (seen.has(analysisPath)) continue;
    seen.add(analysisPath);

    if (fs.existsSync(analysisPath)) {
      try {
        const stat = fs.statSync(analysisPath);
        projects.push({
          name: path.basename(dir),
          dir,
          analysisPath,
          modifiedAt: stat.mtime,
        });
      } catch { /* skip */ }
    }
  }

  // Sort by most recently modified
  projects.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return projects;
}

function loadAnalysis(projectDir?: string): { analysis: AnalysisResult; projectName: string; projectDir: string } | null {
  const projects = discoverProjects();
  if (projects.length === 0) return null;

  let target = projects[0]; // default: most recently modified

  if (projectDir) {
    const match = projects.find(
      (p) => p.dir === projectDir || p.name.toLowerCase() === projectDir.toLowerCase()
    );
    if (match) target = match;
  }

  try {
    const data = fs.readFileSync(target.analysisPath, "utf-8");
    return { analysis: JSON.parse(data), projectName: target.name, projectDir: target.dir };
  } catch {
    return null;
  }
}

// Create MCP server
const server = new McpServer({
  name: "codeatlas",
  version: "1.4.2",
});

// Tool 0: List all discovered projects
server.tool(
  "list_projects",
  "List all projects that have been analyzed by CodeAtlas. Returns project names, paths, and last analysis time.",
  {},
  async () => {
    const projects = discoverProjects();
    if (projects.length === 0) {
      return { content: [{ type: "text" as const, text: "No analyzed projects found. Run 'CodeAtlas: Analyze Project' in VS Code first." }] };
    }

    const result = {
      projectCount: projects.length,
      projects: projects.map((p) => ({
        name: p.name,
        path: p.dir,
        lastAnalyzed: p.modifiedAt.toISOString(),
      })),
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 1: Get project structure
server.tool(
  "get_project_structure",
  "Get all modules, classes, functions, and variables in the analyzed project. Returns entity type, name, file path, and line number.",
  {
    project: z.string().optional().describe("Project name or path (auto-detects if omitted)"),
    type: z.enum(["all", "module", "class", "function", "variable"]).optional().describe("Filter by entity type"),
    limit: z.number().optional().describe("Max results to return (default: 100)"),
  },
  async ({ project, type, limit }) => {
    const loaded = loadAnalysis(project);
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'CodeAtlas: Analyze Project' in VS Code first." }] };
    }

    let nodes = loaded.analysis.graph.nodes;
    if (type && type !== "all") {
      nodes = nodes.filter((n) => n.type === type);
    }

    const maxResults = limit || 100;
    const truncated = nodes.length > maxResults;
    nodes = nodes.slice(0, maxResults);

    const stats = getStats(loaded.analysis);

    const result = {
      project: loaded.projectName,
      projectDir: loaded.projectDir,
      total: loaded.analysis.graph.nodes.length,
      showing: nodes.length,
      truncated,
      stats,
      entities: nodes.map((n) => ({
        name: n.label,
        type: n.type,
        filePath: n.filePath || null,
        line: n.line || null,
      })),
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 2: Get dependencies
server.tool(
  "get_dependencies",
  "Get import/call/containment/implements relationships between entities. Shows how modules, classes, and functions are connected.",
  {
    project: z.string().optional().describe("Project name or path"),
    source: z.string().optional().describe("Filter by source entity name"),
    target: z.string().optional().describe("Filter by target entity name"),
    relationship: z.enum(["all", "import", "call", "contains", "implements"]).optional().describe("Filter by relationship type"),
    limit: z.number().optional().describe("Max results (default: 100)"),
  },
  async ({ project, source, target, relationship, limit }) => {
    const loaded = loadAnalysis(project);
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'CodeAtlas: Analyze Project' first." }] };
    }

    const nodeMap = new Map(loaded.analysis.graph.nodes.map((n) => [n.id, n.label]));
    let links = loaded.analysis.graph.links;

    if (relationship && relationship !== "all") {
      links = links.filter((l) => l.type === relationship);
    }
    if (source) {
      links = links.filter((l) => {
        const label = nodeMap.get(l.source) || l.source;
        return label.toLowerCase().includes(source.toLowerCase());
      });
    }
    if (target) {
      links = links.filter((l) => {
        const label = nodeMap.get(l.target) || l.target;
        return label.toLowerCase().includes(target.toLowerCase());
      });
    }

    const maxResults = limit || 100;
    const truncated = links.length > maxResults;
    links = links.slice(0, maxResults);

    const result = {
      total: loaded.analysis.graph.links.length,
      showing: links.length,
      truncated,
      dependencies: links.map((l) => ({
        source: nodeMap.get(l.source) || l.source,
        target: nodeMap.get(l.target) || l.target,
        type: l.type,
      })),
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 3: Get AI insights
server.tool(
  "get_insights",
  "Get AI-generated code insights including refactoring suggestions, security issues, and maintainability analysis.",
  {},
  async () => {
    const loaded = loadAnalysis();
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'CodeAtlas: Analyze Project' first." }] };
    }

    const stats = getStats(loaded.analysis);

    const result = {
      project: loaded.projectName,
      stats,
      insights: loaded.analysis.insights,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 4: Search entities
server.tool(
  "search_entities",
  "Search for functions, classes, modules, or variables by name. Supports fuzzy matching.",
  {
    project: z.string().optional().describe("Project name or path"),
    query: z.string().describe("Search query (case-insensitive, partial match)"),
    type: z.enum(["all", "module", "class", "function", "variable"]).optional().describe("Filter by entity type"),
  },
  async ({ project, query, type }) => {
    const loaded = loadAnalysis(project);
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'CodeAtlas: Analyze Project' first." }] };
    }

    let nodes = loaded.analysis.graph.nodes;
    if (type && type !== "all") {
      nodes = nodes.filter((n) => n.type === type);
    }

    const q = query.toLowerCase();
    const matches = nodes.filter((n) => n.label.toLowerCase().includes(q));

    // For each match, find its relationships
    const links = loaded.analysis.graph.links;
    const nodeMap = new Map(loaded.analysis.graph.nodes.map((n) => [n.id, n.label]));

    const result = {
      query,
      matchCount: matches.length,
      results: matches.slice(0, 50).map((n) => {
        const incomingLinks = links
          .filter((l) => l.target === n.id)
          .map((l) => ({ from: nodeMap.get(l.source) || l.source, type: l.type }));
        const outgoingLinks = links
          .filter((l) => l.source === n.id)
          .map((l) => ({ to: nodeMap.get(l.target) || l.target, type: l.type }));

        return {
          name: n.label,
          type: n.type,
          filePath: n.filePath || null,
          line: n.line || null,
          incomingRelationships: incomingLinks,
          outgoingRelationships: outgoingLinks,
        };
      }),
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 5: Get file entities
server.tool(
  "get_file_entities",
  "Get all entities (classes, functions, variables) defined in a specific file.",
  {
    project: z.string().optional().describe("Project name or path"),
    filePath: z.string().describe("File path (partial match, e.g. 'User.php' or 'src/models')"),
  },
  async ({ project, filePath }) => {
    const loaded = loadAnalysis(project);
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'CodeAtlas: Analyze Project' first." }] };
    }

    const q = filePath.toLowerCase().replace(/\\/g, "/");
    const matches = loaded.analysis.graph.nodes.filter((n) => {
      const fp = (n.filePath || n.id).toLowerCase().replace(/\\/g, "/");
      return fp.includes(q);
    });

    const links = loaded.analysis.graph.links;
    const nodeMap = new Map(loaded.analysis.graph.nodes.map((n) => [n.id, n.label]));

    // Group by file
    const byFile = new Map<string, typeof matches>();
    for (const n of matches) {
      const fp = n.filePath || "unknown";
      if (!byFile.has(fp)) byFile.set(fp, []);
      byFile.get(fp)!.push(n);
    }

    const result = {
      query: filePath,
      filesFound: byFile.size,
      files: Array.from(byFile.entries()).map(([fp, entities]) => ({
        filePath: fp,
        entities: entities.map((e) => ({
          name: e.label,
          type: e.type,
          line: e.line || null,
          dependencies: links
            .filter((l) => l.source === e.id)
            .map((l) => ({ to: nodeMap.get(l.target) || l.target, type: l.type })),
        })),
      })),
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 6: Generate System Flow — Auto-generate Mermaid diagram from code analysis
server.tool(
  "generate_system_flow",
  "Auto-generate a Mermaid flowchart diagram showing how modules, classes, and functions connect in the system. Returns a Mermaid diagram string that AI can read to understand the full system flow without reading every file.",
  {
    project: z.string().optional().describe("Project name or path"),
    scope: z.enum(["full", "modules-only", "feature"]).optional().describe("Scope of the diagram: 'full' shows all entities, 'modules-only' shows only module relationships (recommended for large projects), 'feature' requires the 'feature' param"),
    feature: z.string().optional().describe("Feature keyword to focus the diagram on (e.g. 'auth', 'crawl', 'payment'). Only used when scope='feature'"),
    maxNodes: z.number().optional().describe("Maximum nodes in diagram (default: 60). Reduce for large projects"),
  },
  async ({ project, scope, feature, maxNodes }) => {
    const loaded = loadAnalysis(project);
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'CodeAtlas: Analyze Project' first." }] };
    }

    const max = maxNodes || 60;
    const diagramScope = scope || "modules-only";
    let nodes = loaded.analysis.graph.nodes;
    let links = loaded.analysis.graph.links;
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    // Filter by scope
    if (diagramScope === "modules-only") {
      nodes = nodes.filter((n) => n.type === "module" && n.filePath);
      const nodeIds = new Set(nodes.map((n) => n.id));
      links = links.filter((l) => nodeIds.has(l.source) && nodeIds.has(l.target) && l.type === "import");
    } else if (diagramScope === "feature" && feature) {
      const q = feature.toLowerCase();
      // Find nodes matching the feature keyword
      const matchingNodes = new Set<string>();
      nodes.forEach((n) => {
        if (n.label.toLowerCase().includes(q) || (n.filePath && n.filePath.toLowerCase().includes(q))) {
          matchingNodes.add(n.id);
        }
      });
      // Expand to include connected nodes (1 hop)
      links.forEach((l) => {
        if (matchingNodes.has(l.source)) matchingNodes.add(l.target);
        if (matchingNodes.has(l.target)) matchingNodes.add(l.source);
      });
      nodes = nodes.filter((n) => matchingNodes.has(n.id));
      const nodeIds = new Set(nodes.map((n) => n.id));
      links = links.filter((l) => nodeIds.has(l.source) && nodeIds.has(l.target));
    }

    // Truncate if too many nodes
    if (nodes.length > max) {
      // Prioritize: modules > classes > functions > variables
      const priorityOrder = ["module", "class", "function", "variable"];
      nodes.sort((a, b) => {
        const ia = priorityOrder.indexOf(a.type);
        const ib = priorityOrder.indexOf(b.type);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });
      nodes = nodes.slice(0, max);
    }

    const truncatedNodeIds = new Set(nodes.map((n) => n.id));
    links = links.filter((l) => truncatedNodeIds.has(l.source) && truncatedNodeIds.has(l.target));

    // Remove duplicate links
    const linkSet = new Set<string>();
    links = links.filter((l) => {
      const key = `${l.source}|${l.target}|${l.type}`;
      if (linkSet.has(key)) return false;
      linkSet.add(key);
      return true;
    });

    // Build Mermaid diagram
    const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_").substring(0, 40);
    const nodeIdMap = new Map<string, string>();
    let counter = 0;

    const getMermaidId = (nodeId: string) => {
      if (!nodeIdMap.has(nodeId)) {
        nodeIdMap.set(nodeId, `n${counter++}`);
      }
      return nodeIdMap.get(nodeId)!;
    };

    const lines: string[] = ["graph TD"];

    // Add node declarations
    for (const node of nodes) {
      const mid = getMermaidId(node.id);
      const label = node.label.replace(/"/g, "'");
      const typeIcon = node.type === "module" ? "📄" : node.type === "class" ? "🏗️" : node.type === "function" ? "⚡" : "📦";
      if (node.type === "module") {
        lines.push(`    ${mid}["${typeIcon} ${label}"]`);
      } else if (node.type === "class") {
        lines.push(`    ${mid}[["${typeIcon} ${label}"]]`);
      } else {
        lines.push(`    ${mid}("${typeIcon} ${label}")`);
      }
    }

    // Add link declarations
    const arrowMap: Record<string, string> = { import: "-->", call: "-.->", contains: "-->", implements: "-.->|implements|" };
    const labelMap: Record<string, string> = { import: "imports", call: "calls", contains: "contains", implements: "implements" };
    for (const link of links) {
      const src = getMermaidId(link.source);
      const tgt = getMermaidId(link.target);
      if (src && tgt) {
        const arrow = arrowMap[link.type] || "-->";
        if (link.type === "contains") {
          lines.push(`    ${src} ${arrow} ${tgt}`);
        } else {
          lines.push(`    ${src} ${arrow}|${labelMap[link.type] || link.type}| ${tgt}`);
        }
      }
    }

    const mermaid = lines.join("\n");

    const result = {
      project: loaded.projectName,
      scope: diagramScope,
      feature: feature || null,
      nodeCount: nodes.length,
      linkCount: links.length,
      truncated: loaded.analysis.graph.nodes.length > max,
      mermaidDiagram: mermaid,
      summary: `System flow for ${loaded.projectName}: ${nodes.filter((n) => n.type === "module").length} modules, ${nodes.filter((n) => n.type === "class").length} classes, ${nodes.filter((n) => n.type === "function").length} functions connected by ${links.length} relationships.`,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 7: Sync System Memory — Create/update .agents/memory/ persistent files
server.tool(
  "sync_system_memory",
  "Create or update the .agents/memory/ folder with auto-generated system documentation. This folder serves as AI's 'long-term memory' — it persists between conversations. After calling this, AI in any future conversation can read these files to understand the full system flow without re-analyzing. Call this after completing any code changes.",
  {
    project: z.string().optional().describe("Project name or path"),
    businessRule: z.string().optional().describe("Optional: A new business rule to add to the memory (e.g. 'VIP users get free shipping')"),
    changeDescription: z.string().optional().describe("Optional: Description of what was just changed (for the changelog)"),
  },
  async ({ project, businessRule, changeDescription }) => {
    const loaded = loadAnalysis(project);
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'CodeAtlas: Analyze Project' first." }] };
    }

    const memoryDir = path.join(loaded.projectDir, ".agents", "memory");
    
    // Create directory structure
    try {
      fs.mkdirSync(memoryDir, { recursive: true });
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Failed to create .agents/memory/ directory: ${e}` }] };
    }

    const nodes = loaded.analysis.graph.nodes;
    const links = loaded.analysis.graph.links;
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const nodeNameMap = new Map(nodes.map((n) => [n.id, n.label]));
    const unifiedStats = getStats(loaded.analysis);

    // === 1. system-map.md — Mermaid diagram of module relationships ===
    const modules = nodes.filter((n) => n.type === "module" && n.filePath);
    const moduleLinks = links.filter((l) => {
      const src = nodeMap.get(l.source);
      const tgt = nodeMap.get(l.target);
      return src?.type === "module" && tgt?.type === "module" && src.filePath && tgt.filePath && l.type === "import";
    });

    // Deduplicate module links
    const mlSet = new Set<string>();
    const dedupModuleLinks = moduleLinks.filter((l) => {
      const key = `${l.source}|${l.target}`;
      if (mlSet.has(key)) return false;
      mlSet.add(key);
      return true;
    });

    // Build compact mermaid (max 50 modules for readability)
    const topModules = modules.slice(0, 50);
    const topModuleIds = new Set(topModules.map((m) => m.id));
    const topModuleLinks = dedupModuleLinks.filter((l) => topModuleIds.has(l.source) && topModuleIds.has(l.target));

    let mermaidLines = ["```mermaid", "graph TD"];
    let nodeCounter = 0;
    const mermaidIdMap = new Map<string, string>();
    for (const mod of topModules) {
      const mid = `m${nodeCounter++}`;
      mermaidIdMap.set(mod.id, mid);
      mermaidLines.push(`    ${mid}["📄 ${mod.label}"]`);
    }
    for (const link of topModuleLinks) {
      const s = mermaidIdMap.get(link.source);
      const t = mermaidIdMap.get(link.target);
      if (s && t) mermaidLines.push(`    ${s} -->|imports| ${t}`);
    }
    mermaidLines.push("```");

    const systemMapContent = [
      `# System Map — ${loaded.projectName}`,
      `> Auto-generated by CodeAtlas MCP on ${new Date().toISOString()}`,
      `> **DO NOT EDIT MANUALLY** — This file is regenerated by \`sync_system_memory\``,
      "",
      `## Overview`,
      `- **Modules**: ${unifiedStats.modules}`,
      `- **Functions**: ${unifiedStats.functions}`,
      `- **Classes**: ${unifiedStats.classes}`,
      `- **Dependencies**: ${unifiedStats.dependencies}`,
      `- **Circular Deps**: ${unifiedStats.circularDeps}`,
      "",
      `## Module Dependency Graph`,
      ...mermaidLines,
      "",
      `## Key Modules (by connection count)`,
    ].join("\n");

    // Count connections per module
    const moduleConnections = new Map<string, number>();
    for (const link of links) {
      if (link.type === "import") {
        moduleConnections.set(link.source, (moduleConnections.get(link.source) || 0) + 1);
        moduleConnections.set(link.target, (moduleConnections.get(link.target) || 0) + 1);
      }
    }
    const keyModules = modules
      .map((m) => ({ name: m.label, path: m.filePath, connections: moduleConnections.get(m.id) || 0 }))
      .sort((a, b) => b.connections - a.connections)
      .slice(0, 20);

    const keyModulesSection = keyModules
      .map((m, i) => `${i + 1}. **${m.name}** (${m.connections} connections) — \`${path.relative(loaded.projectDir, m.path || "")}\``)
      .join("\n");

    fs.writeFileSync(path.join(memoryDir, "system-map.md"), systemMapContent + "\n" + keyModulesSection + "\n");

    // === 2. modules.json — Module registry ===
    const modulesJson = modules.map((m) => {
      const contained = links
        .filter((l) => l.source === m.id && l.type === "contains")
        .map((l) => {
          const target = nodeMap.get(l.target);
          return target ? { name: target.label, type: target.type } : null;
        })
        .filter(Boolean);

      const imports = links
        .filter((l) => l.source === m.id && l.type === "import")
        .map((l) => nodeNameMap.get(l.target) || l.target);

      return {
        name: m.label,
        path: m.filePath ? path.relative(loaded.projectDir, m.filePath) : null,
        contains: contained,
        imports: imports,
        connectionCount: moduleConnections.get(m.id) || 0,
      };
    });

    fs.writeFileSync(path.join(memoryDir, "modules.json"), JSON.stringify(modulesJson, null, 2));

    // === 3. feature-flows.json — Auto-detect feature groups ===
    // Group files by directory as "features"
    const featureMap = new Map<string, string[]>();
    for (const mod of modules) {
      if (!mod.filePath) continue;
      const rel = path.relative(loaded.projectDir, mod.filePath);
      const dir = path.dirname(rel).split(path.sep)[0] || ".";
      if (!featureMap.has(dir)) featureMap.set(dir, []);
      featureMap.get(dir)!.push(rel);
    }

    const featureFlows: Record<string, { files: string[]; entryPoints: string[] }> = {};
    for (const [dir, files] of featureMap) {
      // Entry points: files with most outgoing imports
      const entryPoints = files
        .map((f) => {
          const moduleId = `module:${f.replace(/\\/g, "/")}`;
          const outgoing = links.filter((l) => l.source === moduleId && l.type === "import").length;
          return { file: f, outgoing };
        })
        .sort((a, b) => b.outgoing - a.outgoing)
        .slice(0, 3)
        .map((e) => e.file);

      featureFlows[dir] = { files, entryPoints };
    }

    fs.writeFileSync(path.join(memoryDir, "feature-flows.json"), JSON.stringify(featureFlows, null, 2));

    // === 4. business-rules.json — Persist business rules ===
    const businessRulesPath = path.join(memoryDir, "business-rules.json");
    let businessRules: Array<{ rule: string; addedAt: string }> = [];
    if (fs.existsSync(businessRulesPath)) {
      try {
        businessRules = JSON.parse(fs.readFileSync(businessRulesPath, "utf-8"));
      } catch { /* start fresh */ }
    }
    if (businessRule) {
      businessRules.push({ rule: businessRule, addedAt: new Date().toISOString() });
    }
    fs.writeFileSync(businessRulesPath, JSON.stringify(businessRules, null, 2));

    // === 5. change-log.json — Track recent changes ===
    const changeLogPath = path.join(memoryDir, "change-log.json");
    let changeLog: Array<{ description: string; timestamp: string }> = [];
    if (fs.existsSync(changeLogPath)) {
      try {
        changeLog = JSON.parse(fs.readFileSync(changeLogPath, "utf-8"));
      } catch { /* start fresh */ }
    }
    if (changeDescription) {
      changeLog.unshift({ description: changeDescription, timestamp: new Date().toISOString() });
      // Keep only last 50 entries
      changeLog = changeLog.slice(0, 50);
    }
    fs.writeFileSync(changeLogPath, JSON.stringify(changeLog, null, 2));

    // === 6. conventions.md — Auto-detect conventions ===
    const langs = new Map<string, number>();
    modules.forEach((m) => {
      if (!m.filePath) return;
      const ext = path.extname(m.filePath);
      langs.set(ext, (langs.get(ext) || 0) + 1);
    });

    const topLangs = Array.from(langs.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const dirs = Array.from(featureMap.keys()).sort();

    const conventionsContent = [
      `# Conventions — ${loaded.projectName}`,
      `> Auto-generated by CodeAtlas MCP on ${new Date().toISOString()}`,
      `> **DO NOT EDIT MANUALLY**`,
      "",
      `## Languages`,
      ...topLangs.map(([ext, count]) => `- \`${ext}\`: ${count} files`),
      "",
      `## Project Structure`,
      ...dirs.map((d) => `- \`${d}/\` — ${featureMap.get(d)?.length || 0} files`),
      "",
      `## Architecture Patterns Detected`,
      modules.some((m) => m.filePath?.includes("controller") || m.filePath?.includes("Controller"))
        ? "- ✅ MVC Pattern (Controllers detected)"
        : "",
      modules.some((m) => m.filePath?.includes("service") || m.filePath?.includes("Service"))
        ? "- ✅ Service Layer (Services detected)"
        : "",
      modules.some((m) => m.filePath?.includes("model") || m.filePath?.includes("Model"))
        ? "- ✅ Model Layer (Models detected)"
        : "",
      modules.some((m) => m.filePath?.includes("middleware") || m.filePath?.includes("Middleware"))
        ? "- ✅ Middleware Pattern"
        : "",
      modules.some((m) => m.filePath?.includes("test") || m.filePath?.includes("spec"))
        ? "- ✅ Test Suite Present"
        : "",
    ].filter(Boolean).join("\n");

    fs.writeFileSync(path.join(memoryDir, "conventions.md"), conventionsContent);

    const result = {
      success: true,
      project: loaded.projectName,
      memoryDir,
      filesCreated: [
        "system-map.md",
        "modules.json",
        "feature-flows.json",
        "business-rules.json",
        "change-log.json",
        "conventions.md",
      ],
      stats: {
        modules: modules.length,
        totalEntities: nodes.length,
        totalLinks: links.length,
        businessRulesCount: businessRules.length,
        changeLogEntries: changeLog.length,
      },
      message: `System memory synced for ${loaded.projectName}. AI can read .agents/memory/ at the start of any new conversation to restore full context.`,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 8: Trace Feature Flow — Trace how a feature flows through the codebase
server.tool(
  "trace_feature_flow",
  "Trace the complete flow of a feature through the codebase. Given a keyword (e.g. 'login', 'payment', 'crawl'), finds all related files, classes, and functions, then orders them by dependency chain to show the execution flow. This helps AI understand which files to read when working on a feature.",
  {
    project: z.string().optional().describe("Project name or path"),
    keyword: z.string().describe("Feature keyword to trace (e.g. 'auth', 'crawl', 'payment', 'upload')"),
    depth: z.number().optional().describe("How many hops to follow from matching nodes (default: 2)"),
  },
  async ({ project, keyword, depth }) => {
    const loaded = loadAnalysis(project);
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'CodeAtlas: Analyze Project' first." }] };
    }

    const maxDepth = depth || 2;
    const q = keyword.toLowerCase();
    const nodes = loaded.analysis.graph.nodes;
    const links = loaded.analysis.graph.links;
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    // Step 1: Find seed nodes matching the keyword
    const seedNodes = new Set<string>();
    for (const node of nodes) {
      if (
        node.label.toLowerCase().includes(q) ||
        (node.filePath && node.filePath.toLowerCase().includes(q)) ||
        node.id.toLowerCase().includes(q)
      ) {
        seedNodes.add(node.id);
      }
    }

    if (seedNodes.size === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              keyword,
              matchCount: 0,
              message: `No entities found matching '${keyword}'. Try a broader keyword.`,
              suggestions: nodes
                .filter((n) => n.type === "module" && n.filePath)
                .map((n) => n.label)
                .slice(0, 10),
            }, null, 2),
          },
        ],
      };
    }

    // Step 2: BFS expansion to find connected nodes
    const visited = new Set<string>(seedNodes);
    let frontier = new Set<string>(seedNodes);

    for (let d = 0; d < maxDepth; d++) {
      const nextFrontier = new Set<string>();
      for (const link of links) {
        if (frontier.has(link.source) && !visited.has(link.target)) {
          nextFrontier.add(link.target);
          visited.add(link.target);
        }
        if (frontier.has(link.target) && !visited.has(link.source)) {
          nextFrontier.add(link.source);
          visited.add(link.source);
        }
      }
      frontier = nextFrontier;
    }

    // Step 3: Build the trace result
    const traceNodes = nodes.filter((n) => visited.has(n.id));
    const traceLinks = links.filter((l) => visited.has(l.source) && visited.has(l.target));

    // Group by file for readability
    const byFile = new Map<string, Array<{ name: string; type: string; isSeed: boolean; line: number | null }>>();
    for (const node of traceNodes) {
      const filePath = node.filePath || "external";
      if (!byFile.has(filePath)) byFile.set(filePath, []);
      byFile.get(filePath)!.push({
        name: node.label,
        type: node.type,
        isSeed: seedNodes.has(node.id),
        line: node.line || null,
      });
    }

    // Sort files: seed files first, then by entity count
    const filesArray = Array.from(byFile.entries())
      .map(([filePath, entities]) => ({
        filePath: filePath === "external" ? "external" : path.relative(loaded.projectDir, filePath),
        absolutePath: filePath,
        entities,
        hasSeedMatch: entities.some((e) => e.isSeed),
        entityCount: entities.length,
      }))
      .sort((a, b) => {
        if (a.hasSeedMatch && !b.hasSeedMatch) return -1;
        if (!a.hasSeedMatch && b.hasSeedMatch) return 1;
        return b.entityCount - a.entityCount;
      });

    // Build a reading order (dependency-sorted)
    const fileModuleIds = new Map<string, string>();
    for (const node of traceNodes) {
      if (node.type === "module" && node.filePath) {
        fileModuleIds.set(node.filePath, node.id);
      }
    }

    const result = {
      keyword,
      project: loaded.projectName,
      seedMatches: seedNodes.size,
      totalConnected: visited.size,
      depth: maxDepth,
      files: filesArray.filter((f) => f.filePath !== "external").slice(0, 30),
      externalDeps: filesArray.find((f) => f.filePath === "external")?.entities.map((e) => e.name) || [],
      relationships: traceLinks.slice(0, 50).map((l) => ({
        from: nodeMap.get(l.source)?.label || l.source,
        to: nodeMap.get(l.target)?.label || l.target,
        type: l.type,
      })),
      readingOrder: filesArray
        .filter((f) => f.hasSeedMatch && f.filePath !== "external")
        .map((f) => f.filePath),
      message: `Found ${seedNodes.size} direct matches and ${visited.size - seedNodes.size} connected entities for '${keyword}'. Start reading from the files in 'readingOrder'.`,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("CodeAtlas MCP server running on stdio");
}

main().catch(console.error);
