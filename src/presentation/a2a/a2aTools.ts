/**
 * A2A MCP Tools — CodeAtlas as an A2A Client
 * 
 * These 4 MCP tools let CodeAtlas discover, delegate to, 
 * and share context with other A2A-compatible agents.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkAuth, logActivity } from "../../services/authService.js";
import { a2aClientService } from "../../services/a2aClientService.js";
import { logger } from "../../utils/logger.js";
import { registerTool } from "./agentCard.js";
import { a2aExecutor } from "./a2aExecutor.js";
import { a2aRegistry } from "../../services/a2aRegistry.js";

export function registerA2ATools(server: McpServer): void {

  // Tool 1: Discover A2A agents by capability
  server.tool(
    "a2a_discover_agents",
    "Discover A2A-compatible agents by capability keyword. Returns agent cards with skills, URLs, and status. Use this before delegating tasks to find the right agent.",
    {
      capability: z.string().optional().describe("Filter by capability keyword (e.g. 'code_analysis', 'vulnerability_scan', 'web_search')"),
      status: z.string().optional().describe("Filter by status: 'online', 'all' (default: 'online')"),
    },
    async ({ capability, status }: { capability?: string; status?: string }) => {
      const auth = await checkAuth();
      await logActivity(auth, "a2a_discover_agents", { capability, status });

      const fromRegistry = await a2aRegistry.query({ capability, status: status || "online" });
      const fromCache = await a2aClientService.discover({ capability, status: status || "online" });

      const seen = new Set<string>();
      const agents = [...fromCache, ...fromRegistry.map(r => ({
        agentId: r.agentId, name: r.agentName, url: r.agentUrl,
        capabilities: r.capabilities, status: r.status,
        lastSeen: r.lastHeartbeat.toISOString(),
      }))].filter(a => { if (seen.has(a.url)) return false; seen.add(a.url); return true; });

      for (const agent of agents) {
        a2aClientService.registerAgent(agent.url, agent);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            agentCount: agents.length, agents,
            message: agents.length === 0 ? "No agents found." : `Found ${agents.length} agent(s).`,
          }, null, 2),
        }],
      };
    }
  );

  // Tool 2: Delegate a task to a remote A2A agent
  server.tool(
    "a2a_delegate_task",
    "Delegate a code analysis task to a remote A2A-compatible agent. Sends a JSON-RPC tasks/send request and returns the task result.",
    {
      agent_url: z.string().describe("The remote A2A agent's base URL (e.g. 'http://agent-host:3000')"),
      tool_name: z.string().describe("Name of the skill/tool to invoke on the remote agent"),
      params: z.record(z.any()).optional().describe("Parameters to pass to the remote tool (default: {})"),
    },
    async ({ agent_url, tool_name, params }: { agent_url: string; tool_name: string; params?: Record<string, any> }) => {
      const auth = await checkAuth();
      await logActivity(auth, "a2a_delegate_task", { agent_url, tool_name });

      try {
        const result = await a2aClientService.sendTask(agent_url, tool_name, params || {});
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[A2A] Delegate task failed: ${message}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Failed: ${message}`, agent_url, tool_name }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  // Tool 3: Check task status on remote agent
  server.tool(
    "a2a_get_task_status",
    "Check the status of a previously delegated task on a remote A2A agent.",
    {
      agent_url: z.string().describe("The A2A agent's base URL"),
      task_id: z.string().describe("Task ID returned by a2a_delegate_task"),
    },
    async ({ agent_url, task_id }: { agent_url: string; task_id: string }) => {
      const auth = await checkAuth();
      await logActivity(auth, "a2a_get_task_status", { agent_url, task_id });

      try {
        const status = await a2aClientService.getTaskStatus(agent_url, task_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }], isError: true };
      }
    }
  );

  // Tool 4: Share context via Dreaming Memory
  server.tool(
    "a2a_broadcast_context",
    "Share context/learnings via CodeAtlas Dreaming Memory so other agents can discover it through semantic search. Stores as A2A_SHARED_CONTEXT type.",
    {
      project: z.string().describe("Project name the context belongs to"),
      key: z.string().describe("Context key for lookup"),
      value: z.string().describe("Context value — any JSON-serializable content"),
      visibility: z.string().optional().describe("'team' or 'org' (default: 'team')"),
    },
    async ({ project, key, value, visibility }: { project: string; key: string; value: string; visibility?: string }) => {
      const auth = await checkAuth();
      await logActivity(auth, "a2a_broadcast_context", { project, key });

      try {
        await a2aClientService.shareContext(project, key, value, visibility || "team");
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "shared", project, key, visibility: visibility || "team" }, null, 2) }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }], isError: true };
      }
    }
  );

  // Register A2A tools in Agent Card
  registerTool({ name: "a2a_discover_agents", description: "Discover A2A-compatible agents by capability keyword.", params: ["capability", "status"] });
  registerTool({ name: "a2a_delegate_task", description: "Delegate a code analysis task to a remote A2A agent via JSON-RPC.", params: ["agent_url", "tool_name", "params"] });
  registerTool({ name: "a2a_get_task_status", description: "Check the status of a previously delegated A2A task.", params: ["agent_url", "task_id"] });
  registerTool({ name: "a2a_broadcast_context", description: "Share context via CodeAtlas Dreaming Memory for agent discovery.", params: ["project", "key", "value", "visibility"] });

  logger.info("[A2A Tools] Registered 4 A2A client tools + Agent Card auto-registration");
}
