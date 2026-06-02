import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { checkAuth, logActivity } from "../services/authService.js";
import { 
  discoverProjectsAsync, 
  loadAnalysisAsync, 
  getStats, 
  fileExists, 
  AnalysisResultLocal,
  registerProject
} from "../services/projectService.js";
import { OracleMemoryService } from "../oracleDatabase.js";
import { SecurityScanner } from "../securityScanner.js";

export function registerTools(server: McpServer) {
  // Tool -1: Analyze a project
  server.tool(
    "analyze",
    "Perform deep code analysis on a local project directory. Generates .codeatlas/analysis.json.",
    {
      path: z.string().describe("Absolute path to the project directory to analyze"),
      maxFiles: z.number().optional().describe("Maximum files to analyze (default: 5000)"),
    },
    async ({ path: projectPath, maxFiles }: { path: string; maxFiles?: number }) => {
      const auth = await checkAuth();
      await logActivity(auth, "analyze", { path: projectPath, maxFiles });
      
      return {
        content: [{
          type: "text" as const,
          text: `Local indexing is not supported on a pure cloud API server. Please trigger indexing locally from your codeatlas-enterprise client to synchronize AST data.`
        }],
        isError: true
      };
    }
  );

  // Tool 0: List all discovered projects
  server.tool(
    "list_projects",
    "List all projects that have been analyzed by CodeAtlas. Returns project names, paths, and last analysis time.",
    {},
    async () => {
      const auth = await checkAuth();
      await logActivity(auth, "list_projects", {});
      const projects = await discoverProjectsAsync(auth.uid);
      if (projects.length === 0) {
        return { content: [{ type: "text" as const, text: "No analyzed projects found. Run 'analyze' tool first." }] };
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
    async ({ project, type, limit }: { project?: string; type?: string; limit?: number }) => {
      const auth = await checkAuth();
      await logActivity(auth, "get_project_structure", { project, type, limit });
      const loaded = await loadAnalysisAsync(project);
      if (!loaded) {
        return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
      }

      let nodes = loaded.analysis.graph.nodes;
      if (type && type !== "all") {
        nodes = nodes.filter((n) => n.type === type);
      }

      // Filter out venv/node_modules entities
      nodes = nodes.filter((n) => {
        const fp = n.filePath || "";
        return !fp.includes("node_modules") && !fp.includes("venv") && !fp.includes(".venv") && !fp.includes("site-packages");
      });

      const maxResults = limit || 500;
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
          filePath: n.filePath ? (path.isAbsolute(n.filePath) ? n.filePath : path.resolve(loaded.projectDir, n.filePath)) : null,
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
    async ({ project, source, target, relationship, limit }: { project?: string; source?: string; target?: string; relationship?: string; limit?: number }) => {
      const auth = await checkAuth();
      await logActivity(auth, "get_dependencies", { project, source, target, relationship, limit });
      const loaded = await loadAnalysisAsync(project);
      if (!loaded) {
        return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
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

      // Deduplicate links
      const linkDedup = new Set<string>();
      links = links.filter((l) => {
        const key = l.source + '|' + l.target + '|' + l.type;
        if (linkDedup.has(key)) return false;
        linkDedup.add(key);
        return true;
      });

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
      const auth = await checkAuth();
      await logActivity(auth, "get_insights", {});
      const loaded = await loadAnalysisAsync();
      if (!loaded) {
        return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
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
    async ({ project, query, type }: { project?: string; query: string; type?: string }) => {
      const auth = await checkAuth();
      await logActivity(auth, "search_entities", { project, query, type });
      const loaded = await loadAnalysisAsync(project);
      if (!loaded) {
        return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
      }

      let nodes = loaded.analysis.graph.nodes;
      if (type && type !== "all") {
        nodes = nodes.filter((n) => n.type === type);
      }

      // Filter out venv/node_modules entities for cleaner results
      nodes = nodes.filter((n) => {
        if (n.id.startsWith('external:')) return false;
        if (n.filePath && (
          n.filePath.includes('/venv/') ||
          n.filePath.includes('/.venv/') ||
          n.filePath.includes('/node_modules/') ||
          n.filePath.includes('/site-packages/')
        )) return false;
        return true;
      });

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
            filePath: n.filePath ? (path.isAbsolute(n.filePath) ? n.filePath : path.resolve(loaded.projectDir, n.filePath)) : null,
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
    async ({ filePath, project }: { project?: string; filePath: string }) => {
      const auth = await checkAuth();
      await logActivity(auth, "get_file_entities", { filePath, project });
      const loaded = await loadAnalysisAsync(project);
      if (!loaded) {
        return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
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

      let filesEntries = Array.from(byFile.entries());

      const result = {
        query: filePath,
        filesFound: byFile.size,
        showing: filesEntries.length,
        truncated: byFile.size > filesEntries.length,
        files: filesEntries.map(([fp, entities]) => ({
          filePath: fp === "unknown" ? "unknown" : (path.isAbsolute(fp) ? fp : path.resolve(loaded.projectDir, fp)),
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

  // Tool 6: Generate System Flow
  server.tool(
    "generate_system_flow",
    "Auto-generate a Mermaid flowchart diagram showing how modules, classes, and functions connect in the system. Returns a Mermaid diagram string that AI can read to understand the full system flow without reading every file.",
    {
      project: z.string().optional().describe("Project name or path"),
      scope: z.enum(["full", "modules-only", "feature"]).optional().describe("Scope of the diagram: 'full' shows all entities, 'modules-only' shows only module relationships (recommended for large projects), 'feature' requires the 'feature' param"),
      feature: z.string().optional().describe("Feature keyword to focus the diagram on (e.g. 'auth', 'crawl', 'payment'). Only used when scope='feature'"),
      maxNodes: z.number().optional().describe("Maximum nodes in diagram (default: 60). Reduce for large projects"),
    },
    async ({ project, scope, feature, maxNodes }: { project?: string; scope?: string; feature?: string; maxNodes?: number }) => {
      const auth = await checkAuth();
      await logActivity(auth, "generate_system_flow", { project, scope, feature, maxNodes });
      const loaded = await loadAnalysisAsync(project);
      if (!loaded) {
        return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
      }

      const max = maxNodes || 60;
      const diagramScope = scope || "modules-only";
      let nodes = loaded.analysis.graph.nodes;
      let links = loaded.analysis.graph.links;
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));

      // Filter by scope
      if (diagramScope === "modules-only") {
        nodes = nodes.filter((n) => n.type === "module" && (n.filePath || n.id.startsWith("external:")));
        const nodeIds = new Set(nodes.map((n) => n.id));
        links = links.filter((l) => nodeIds.has(l.source) && nodeIds.has(l.target) && l.type === "import");
      } else if (diagramScope === "feature" && feature) {
        const q = feature.toLowerCase();
        const matchingNodes = new Set<string>();
        nodes.forEach((n) => {
          if (n.label.toLowerCase().includes(q) || (n.filePath && n.filePath.toLowerCase().includes(q))) {
            matchingNodes.add(n.id);
          }
        });
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
      const nodeIdMap = new Map<string, string>();
      let counter = 0;

      const getMermaidId = (nodeId: string) => {
        if (!nodeIdMap.has(nodeId)) {
          nodeIdMap.set(nodeId, `n${counter++}`);
        }
        return nodeIdMap.get(nodeId)!;
      };

      const lines: string[] = ["graph TD"];

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

  // Tool 7: Sync System Memory
  server.tool(
    "sync_system_memory",
    "Create or update the .agents/memory/ folder with auto-generated system documentation. This folder serves as AI's 'long-term memory' — it persists between conversations. After calling this, AI in any future conversation can read these files to understand the full system flow without re-analyzing. Call this after completing any code changes.",
    {
      project: z.string().optional().describe("Project name or path"),
      businessRule: z.string().optional().describe("Optional: A new business rule to add to the memory (e.g. 'VIP users get free shipping')"),
      changeDescription: z.string().optional().describe("Optional: Description of what was just changed (for the changelog)"),
      enableEnterpriseSync: z.boolean().optional().default(true).describe("If true, syncs data to Oracle 26ai Knowledge Graph (Pro/Plus feature). Default is true."),
    },
    async ({ project, businessRule, changeDescription, enableEnterpriseSync }: { project?: string; businessRule?: string; changeDescription?: string; enableEnterpriseSync?: boolean }) => {
      const auth = await checkAuth();
      await logActivity(auth, "sync_system_memory", { project, businessRule, changeDescription, enableEnterpriseSync });
      const loaded = await loadAnalysisAsync(project);
      if (!loaded) {
        return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
      }

      const nodes = loaded.analysis.graph.nodes;
      const links = loaded.analysis.graph.links;

      let syncSuccess = false;
      let syncError: string | undefined;
      let businessRuleSaved = false;
      let changeDescriptionSaved = false;

      // Sync to Oracle 26ai
      if (enableEnterpriseSync !== false && process.env.ORACLE_CONN_STRING) {
        try {
          console.error(`Syncing Knowledge Graph for ${loaded.projectName} to Oracle 26ai...`);
          await OracleMemoryService.saveSemanticMemory(loaded.projectName, nodes);
          await OracleMemoryService.saveRelationalMemory(loaded.projectName, links);
          if (businessRule) {
            await OracleMemoryService.saveEpisodicMemory(loaded.projectName, "BUSINESS_RULE", businessRule);
            businessRuleSaved = true;
          }
          if (changeDescription) {
            await OracleMemoryService.saveEpisodicMemory(loaded.projectName, "CHANGE_LOG", changeDescription);
            changeDescriptionSaved = true;
          }
          syncSuccess = true;
        } catch (oracleErr: any) {
          syncError = oracleErr instanceof Error ? oracleErr.message : String(oracleErr);
          console.error("Failed to sync to Oracle:", oracleErr);
        }
      } else {
        if (enableEnterpriseSync === false) {
          if (businessRule || changeDescription) {
            syncError = "Sync skipped (enableEnterpriseSync is false), cannot save episodic memory.";
          } else {
            syncSuccess = true; // No episodic memory requested, so no-op is successful
          }
        } else {
          syncError = "Oracle DB connection string is not configured.";
        }
      }

      const result = {
        success: syncSuccess,
        project: loaded.projectName,
        stats: {
          modules: nodes.filter((n) => n.type === "module").length,
          totalEntities: nodes.length,
          totalLinks: links.length,
          businessRuleSaved,
          changeDescriptionSaved,
        },
        error: syncError,
        message: syncSuccess
          ? `System memory synced to database for ${loaded.projectName}. Local file writing deprecated.`
          : `System memory sync failed or skipped: ${syncError}`,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Tool 7.5: Get System Memory (Episodic memories like business rules and change logs)
  server.tool(
    "get_system_memory",
    "Retrieve the auto-generated system documentation and episodic memories (business rules and change logs) for a project from the Oracle 26ai Knowledge Graph database.",
    {
      project: z.string().optional().describe("Project name or path"),
      eventType: z.enum(["all", "BUSINESS_RULE", "CHANGE_LOG"]).optional().default("all").describe("Filter by event type"),
    },
    async ({ project, eventType }: { project?: string; eventType?: "all" | "BUSINESS_RULE" | "CHANGE_LOG" }) => {
      const auth = await checkAuth();
      await logActivity(auth, "get_system_memory", { project, eventType });
      const loaded = await loadAnalysisAsync(project);
      if (!loaded) {
        return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
      }

      if (!process.env.ORACLE_CONN_STRING) {
        return { content: [{ type: "text" as const, text: "Oracle DB connection string is not configured." }] };
      }

      try {
        const filterType = eventType === "all" ? undefined : eventType;
        const memories = await OracleMemoryService.getEpisodicMemories(loaded.projectName, filterType);

        const parsedMemories = memories.map((m: any) => {
          let val = null;
          try {
            if (m.EVENT_DATA) {
              if (typeof m.EVENT_DATA === "string") {
                const parsed = JSON.parse(m.EVENT_DATA);
                val = parsed.val !== undefined ? parsed.val : parsed;
              } else if (typeof m.EVENT_DATA === "object") {
                val = m.EVENT_DATA.val !== undefined ? m.EVENT_DATA.val : m.EVENT_DATA;
              }
            }
          } catch (e) {
            val = m.EVENT_DATA;
          }
          return {
            id: m.ID,
            eventType: m.EVENT_TYPE,
            data: val,
            createdAt: m.CREATED_AT
          };
        });

        const result = {
          success: true,
          project: loaded.projectName,
          count: parsedMemories.length,
          memories: parsedMemories
        };

        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed to retrieve system memory: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // Tool 8: Trace Feature Flow
  server.tool(
    "trace_feature_flow",
    "Trace the complete flow of a feature through the codebase. Given a keyword (e.g. 'login', 'payment', 'crawl'), finds all related files, classes, and functions, then orders them by dependency chain to show the execution flow. This helps AI understand which files to read when working on a feature.",
    {
      project: z.string().optional().describe("Project name or path"),
      keyword: z.string().describe("Feature keyword to trace (e.g. 'auth', 'crawl', 'payment', 'upload')"),
      depth: z.number().optional().describe("How many hops to follow from matching nodes (default: 2)"),
    },
    async ({ keyword, project, depth }: { keyword: string; project?: string; depth?: number }) => {
      const auth = await checkAuth();
      await logActivity(auth, "trace_feature_flow", { keyword, project, depth });
      const loaded = await loadAnalysisAsync(project);
      if (!loaded) {
        return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
      }

      const maxDepth = depth || 2;
      const q = keyword.toLowerCase();
      const nodes = loaded.analysis.graph.nodes;
      const links = loaded.analysis.graph.links;
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));

      const seedNodes = new Set<string>();
      for (const node of nodes) {
        if (node.id.startsWith('external:')) continue;
        if (node.filePath && (
          node.filePath.includes('/venv/') ||
          node.filePath.includes('/.venv/') ||
          node.filePath.includes('/node_modules/') ||
          node.filePath.includes('/vendor/') ||
          node.filePath.includes('/site-packages/')
        )) continue;

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

      const traceNodes = nodes.filter((n) => visited.has(n.id));
      const traceLinks = links.filter((l) => visited.has(l.source) && visited.has(l.target));

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

      const filesArray = Array.from(byFile.entries())
        .map(([filePath, entities]) => {
          const isExt = filePath === "external";
          const relPath = isExt ? "external" : (path.isAbsolute(filePath) ? path.relative(loaded.projectDir, filePath) : filePath);
          const absPath = isExt ? "external" : (path.isAbsolute(filePath) ? filePath : path.resolve(loaded.projectDir, filePath));
          return {
            filePath: relPath,
            absolutePath: absPath,
            entities,
            hasSeedMatch: entities.some((e) => e.isSeed),
            entityCount: entities.length,
          };
        })
        .sort((a, b) => {
          if (a.hasSeedMatch && !b.hasSeedMatch) return -1;
          if (!a.hasSeedMatch && b.hasSeedMatch) return 1;
          return b.entityCount - a.entityCount;
        });

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

  // Tool 9: Generate Feature Flow Diagram
  server.tool(
    "generate_feature_flow_diagram",
    "Generate a Mermaid diagram showing the EXECUTION FLOW of a feature. Unlike generate_system_flow (which shows module imports), this traces the actual call chain: entry point → controller → service → model → database. Given a keyword, it finds all related functions and classes, then builds a flowchart or sequence diagram showing how they call each other at runtime. This is the best tool for understanding HOW a feature works step-by-step.",
    {
      project: z.string().optional().describe("Project name or path"),
      keyword: z.string().describe("Feature keyword to trace (e.g. 'login', 'payment', 'upload', 'auth')"),
      diagramType: z.enum(["flowchart", "sequence"]).optional().describe("Type of Mermaid diagram: 'flowchart' (default) shows call graph, 'sequence' shows step-by-step execution order"),
      depth: z.number().optional().describe("How many call hops to follow (default: 3)"),
      maxNodes: z.number().optional().describe("Maximum nodes in diagram (default: 40)"),
    },
    async ({ project, keyword, diagramType, depth, maxNodes }: { project?: string; keyword: string; diagramType?: 'flowchart' | 'sequence'; depth?: number; maxNodes?: number }) => {
      const auth = await checkAuth();
      await logActivity(auth, "generate_feature_flow_diagram", { project, keyword, diagramType, depth, maxNodes });
      const loaded = await loadAnalysisAsync(project);
      if (!loaded) {
        return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
      }

      const q = keyword.toLowerCase();
      const maxDepth = depth || 3;
      const maxN = maxNodes || 40;
      const dType = diagramType || "flowchart";
      const nodes = loaded.analysis.graph.nodes;
      const links = loaded.analysis.graph.links;
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));
      const nodeNameMap = new Map(nodes.map((n) => [n.id, n.label]));

      const seedNodes = new Set<string>();
      for (const node of nodes) {
        if (node.id.startsWith('external:')) continue;
        if (node.filePath && (
          node.filePath.includes('/venv/') ||
          node.filePath.includes('/.venv/') ||
          node.filePath.includes('/node_modules/') ||
          node.filePath.includes('/vendor/') ||
          node.filePath.includes('/site-packages/')
        )) continue;

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
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              keyword,
              matchCount: 0,
              message: `No entities found matching '${keyword}'. Try a broader keyword.`,
              suggestions: nodes
                .filter((n) => n.type === "function" || n.type === "class")
                .map((n) => n.label)
                .filter((l, i, arr) => arr.indexOf(l) === i)
                .slice(0, 15),
            }, null, 2),
          }],
        };
      }

      const visited = new Set<string>(seedNodes);
      let frontier = new Set<string>(seedNodes);
      const callAndContainsLinks = links.filter((l) => l.type === "call" || l.type === "contains");

      for (let d = 0; d < maxDepth; d++) {
        const nextFrontier = new Set<string>();
        for (const link of callAndContainsLinks) {
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
        if (nextFrontier.size === 0) break;
      }

      let traceNodes = nodes.filter((n) => visited.has(n.id) && (n.type === "function" || n.type === "class"));

      if (traceNodes.length > maxN) {
        const callConnections = new Map<string, number>();
        for (const link of links) {
          if (link.type === "call") {
            callConnections.set(link.source, (callConnections.get(link.source) || 0) + 1);
            callConnections.set(link.target, (callConnections.get(link.target) || 0) + 1);
          }
        }
        traceNodes.sort((a, b) => {
          if (seedNodes.has(a.id) && !seedNodes.has(b.id)) return -1;
          if (!seedNodes.has(a.id) && seedNodes.has(b.id)) return 1;
          return (callConnections.get(b.id) || 0) - (callConnections.get(a.id) || 0);
        });
        traceNodes = traceNodes.slice(0, maxN);
      }

      const traceNodeIds = new Set(traceNodes.map((n) => n.id));
      const traceLinks = links.filter(
        (l) => traceNodeIds.has(l.source) && traceNodeIds.has(l.target) && l.type === "call"
      );

      const linkSet = new Set<string>();
      const dedupLinks = traceLinks.filter((l) => {
        const key = `${l.source}|${l.target}`;
        if (linkSet.has(key)) return false;
        linkSet.add(key);
        return true;
      });

      const hasIncoming = new Set<string>();
      for (const link of dedupLinks) {
        hasIncoming.add(link.target);
      }
      const entryPoints = traceNodes.filter(
        (n) => !hasIncoming.has(n.id) || seedNodes.has(n.id)
      );

      let mermaid = "";
      const sanitizeLabel = (s: string) => s.replace(/"/g, "'").replace(/[<>]/g, "");

      if (dType === "sequence") {
        const seqLines: string[] = ["sequenceDiagram"];
        const participantMap = new Map<string, string>();
        let pCounter = 0;
        for (const node of traceNodes) {
          const pid = `P${pCounter++}`;
          participantMap.set(node.id, pid);
          const icon = node.type === "class" ? "🏗️" : "⚡";
          const fileSuffix = node.filePath ? ` (${path.basename(node.filePath)})` : "";
          seqLines.push(`    participant ${pid} as ${icon} ${sanitizeLabel(node.label)}${fileSuffix}`);
        }

        for (const link of dedupLinks) {
          const src = participantMap.get(link.source);
          const tgt = participantMap.get(link.target);
          if (src && tgt && src !== tgt) {
            seqLines.push(`    ${src}->>+${tgt}: calls`);
            seqLines.push(`    ${tgt}-->>-${src}: returns`);
          }
        }

        mermaid = seqLines.join("\n");
      } else {
        const flowLines: string[] = ["graph TD"];
        flowLines.push("    classDef entry fill:#4CAF50,stroke:#388E3C,color:#fff,stroke-width:2px");
        flowLines.push("    classDef seed fill:#2196F3,stroke:#1565C0,color:#fff,stroke-width:2px");
        flowLines.push("    classDef cls fill:#FF9800,stroke:#E65100,color:#fff");
        flowLines.push("    classDef func fill:#607D8B,stroke:#37474F,color:#fff");

        const mermaidIdMap = new Map<string, string>();
        let nCounter = 0;
        for (const node of traceNodes) {
          const mid = `f${nCounter++}`;
          mermaidIdMap.set(node.id, mid);
          const label = sanitizeLabel(node.label);
          const fileSuffix = node.filePath ? `<br/>${path.basename(node.filePath)}` : "";

          if (node.type === "class") {
            flowLines.push(`    ${mid}[["🏗️ ${label}${fileSuffix}"]]`);
          } else {
            flowLines.push(`    ${mid}("⚡ ${label}${fileSuffix}")`);
          }

          if (entryPoints.includes(node) && !hasIncoming.has(node.id)) {
            flowLines.push(`    class ${mid} entry`);
          } else if (seedNodes.has(node.id)) {
            flowLines.push(`    class ${mid} seed`);
          } else if (node.type === "class") {
            flowLines.push(`    class ${mid} cls`);
          } else {
            flowLines.push(`    class ${mid} func`);
          }
        }

        for (const link of dedupLinks) {
          const src = mermaidIdMap.get(link.source);
          const tgt = mermaidIdMap.get(link.target);
          if (src && tgt) {
            flowLines.push(`    ${src} -->|calls| ${tgt}`);
          }
        }

        flowLines.push("");
        flowLines.push(`    subgraph Legend`);
        flowLines.push(`        L1("🟢 Entry Point"):::entry`);
        flowLines.push(`        L2("🔵 Keyword Match"):::seed`);
        flowLines.push(`        L3("🟠 Class"):::cls`);
        flowLines.push(`        L4("⬜ Function"):::func`);
        flowLines.push(`    end`);

        mermaid = flowLines.join("\n");
      }

      const executionOrder: Array<{
        step: number;
        name: string;
        type: string;
        file: string | null;
        line: number | null;
        callsTo: string[];
        calledBy: string[];
      }> = [];

      const inDegree = new Map<string, number>();
      for (const node of traceNodes) {
        inDegree.set(node.id, 0);
      }
      for (const link of dedupLinks) {
        inDegree.set(link.target, (inDegree.get(link.target) || 0) + 1);
      }

      const queue: string[] = [];
      for (const [id, deg] of inDegree) {
        if (deg === 0) queue.push(id);
      }

      let step = 1;
      const ordered = new Set<string>();
      while (queue.length > 0 && step <= maxN) {
        const current = queue.shift()!;
        if (ordered.has(current)) continue;
        ordered.add(current);

        const node = nodeMap.get(current);
        if (node) {
          const callsTo = dedupLinks
            .filter((l) => l.source === current)
            .map((l) => nodeNameMap.get(l.target) || l.target);
          const calledBy = dedupLinks
            .filter((l) => l.target === current)
            .map((l) => nodeNameMap.get(l.source) || l.source);

          executionOrder.push({
            step: step++,
            name: node.label,
            type: node.type,
            file: node.filePath ? (path.isAbsolute(node.filePath) ? path.relative(loaded.projectDir, node.filePath) : node.filePath) : null,
            line: node.line || null,
            callsTo,
            calledBy,
          });
        }

        for (const link of dedupLinks) {
          if (link.source === current) {
            const newDeg = (inDegree.get(link.target) || 1) - 1;
            inDegree.set(link.target, newDeg);
            if (newDeg <= 0 && !ordered.has(link.target)) {
              queue.push(link.target);
            }
          }
        }
      }

      for (const node of traceNodes) {
        if (!ordered.has(node.id)) {
          const callsTo = dedupLinks
            .filter((l) => l.source === node.id)
            .map((l) => nodeNameMap.get(l.target) || l.target);
          const calledBy = dedupLinks
            .filter((l) => l.target === node.id)
            .map((l) => nodeNameMap.get(l.source) || l.source);

          executionOrder.push({
            step: step++,
            name: node.label,
            type: node.type,
            file: node.filePath ? (path.isAbsolute(node.filePath) ? path.relative(loaded.projectDir, node.filePath) : node.filePath) : null,
            line: node.line || null,
            callsTo,
            calledBy,
          });
        }
      }

      const result = {
        keyword,
        project: loaded.projectName,
        diagramType: dType,
        seedMatches: seedNodes.size,
        nodesInDiagram: traceNodes.length,
        callRelationships: dedupLinks.length,
        entryPoints: entryPoints.map((n) => ({
          name: n.label,
          type: n.type,
          file: n.filePath ? (path.isAbsolute(n.filePath) ? path.relative(loaded.projectDir, n.filePath) : n.filePath) : null,
        })),
        mermaidDiagram: mermaid,
        executionOrder,
        readingOrder: executionOrder
          .filter((e) => e.file)
          .map((e) => e.file!)
          .filter((f, i, arr) => arr.indexOf(f) === i),
        message: `Generated ${dType} diagram for '${keyword}': ${traceNodes.length} nodes, ${dedupLinks.length} call relationships. Entry points: ${entryPoints.map((n) => n.label).join(", ")}`,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Tool 11: Detect Architectural Smells
  server.tool(
    "detect_architectural_smells",
    "Knowledge Graph Reasoning: Use Oracle 26ai Graph features to automatically detect architectural weaknesses, circular dependencies, God objects, and dead code.",
    {
      project: z.string().optional().describe("Project name or path"),
    },
    async ({ project }: { project?: string }) => {
      const auth = await checkAuth();
      await logActivity(auth, "detect_architectural_smells", { project });
      const loaded = await loadAnalysisAsync(project);
      if (!loaded) {
        return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
      }

      try {
        const smells = await OracleMemoryService.detectArchitecturalSmells(loaded.projectName);
        if (!smells) {
          return { content: [{ type: "text" as const, text: "Failed to run graph reasoning on Oracle 26ai. Ensure graph tables are initialized." }] };
        }

        const result = {
          project: loaded.projectName,
          timestamp: new Date().toISOString(),
          findings: {
            circularDependencies: {
              count: smells.circularDependencies.length,
              details: smells.circularDependencies,
              impact: "High - Causes tight coupling and build issues."
            },
            godObjects: {
              count: smells.godObjects.length,
              details: smells.godObjects,
              impact: "Medium - Violates Single Responsibility Principle, hard to maintain."
            },
            deadCode: {
              count: smells.deadCode.length,
              details: smells.deadCode,
              impact: "Low - Increases codebase size and cognitive load."
            }
          },
          recommendation: "Review high-impact findings (Circular Dependencies) first. Refactor God Objects into smaller services."
        };

        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `Oracle Graph Reasoning failed: ${(err instanceof Error ? err.message : String(err))}` }] };
      }
    }
  );

  // Tool 12: Scan Enterprise Vulnerabilities
  server.tool(
    "scan_enterprise_vulnerabilities",
    "Enterprise Scanner: Automatically scan all analyzed projects for bugs, security vulnerabilities (hardcoded secrets, unsafe functions), and architectural problems. Features Admin Insights and Security Scoring.",
    {
      maxProjects: z.number().optional().describe("Maximum number of projects to scan (default: all)"),
    },
    async ({ maxProjects }: { maxProjects?: number }) => {
      const auth = await checkAuth();
      await logActivity(auth, "scan_enterprise_vulnerabilities", { maxProjects });
      const projects = await discoverProjectsAsync(auth.uid);
      
      if (projects.length === 0) {
        return { content: [{ type: "text" as const, text: "No analyzed projects found. Run 'analyze' tool first." }] };
      }

      const isEnterprise = auth.tier === 'enterprise';
      const scanResults: any[] = [];
      const limit = maxProjects || (isEnterprise ? projects.length : 3);
      const projectsToScan = projects.slice(0, limit);

      for (const p of projectsToScan) {
        try {
          const loaded = await loadAnalysisAsync(p.name);
          if (!loaded) continue;

          const vulnerabilities = SecurityScanner.scan(loaded.analysis);
          
          const stats = getStats(loaded.analysis as any);
          const circularDeps = stats.circularDeps || 0;
          const deadCode = stats.deadCode || 0;
          
          const riskLevel = vulnerabilities.length > 10 ? "CRITICAL" : (vulnerabilities.length > 0 ? "HIGH" : "LOW");
          const securityScore = Math.max(0, 100 - (vulnerabilities.length * 5) - (circularDeps * 2));

          scanResults.push({
            project: p.name,
            riskLevel,
            securityScore: isEnterprise ? securityScore : "Upgrade to view",
            vulnerabilities: vulnerabilities.length,
            circularDependencies: circularDeps,
            deadCode: deadCode,
            adminInsights: isEnterprise ? `Project health is ${securityScore > 80 ? 'EXCELLENT' : 'NEEDS ATTENTION'}. Priority: ${riskLevel}.` : null,
            details: { vulnerabilities }
          });
        } catch (err: unknown) {
          scanResults.push({ 
            project: p.name, 
            error: `Scan failed: ${(err instanceof Error ? err.message : String(err))}`
          });
        }
      }

      const finalReport = {
        timestamp: new Date().toISOString(),
        tier: auth.tier,
        projectsScanned: projectsToScan.length,
        totalProjectsDiscovered: projects.length,
        results: scanResults,
        enterpriseStatus: isEnterprise ? "ACTIVE (Admin Enabled)" : "INACTIVE"
      };

      return { 
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify(finalReport, null, 2)
        }] 
      };
    }
  );
}

// Create the global MCP server instance
export const server = new McpServer(
  {
    name: "CodeAtlas",
    version: "2.13.1",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
      logging: {},
    },
  }
);

registerTools(server);

