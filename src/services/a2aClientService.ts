/**
 * A2A Client Service — wraps A2A client operations
 * 
 * Handles agent discovery, task delegation, and shared context.
 * Uses Oracle Dreaming Memory for shared context persistence.
 */

import { randomUUID } from "node:crypto";
import { OracleDreamingService, type DreamMemoryType } from "./dreamingService.js";
import { logger } from "../utils/logger.js";
import { authStorage } from "../utils/context.js";

export interface A2AAgentInfo {
  agentId: string;
  name: string;
  url: string;
  capabilities: string[];
  status: "online" | "offline";
  lastSeen: string;
}

export interface A2ADiscoverFilter {
  capability?: string;
  status?: string;
}

export class A2AClientService {
  /** In-memory cache of discovered agents (tenantId → URL → AgentCard) */
  private agentCache = new Map<string, Map<string, unknown>>();

  private getTenantCache(): Map<string, unknown> {
    const auth = authStorage.getStore();
    const tenantId = auth ? auth.uid : "admin";
    if (!this.agentCache.has(tenantId)) {
      this.agentCache.set(tenantId, new Map<string, unknown>());
    }
    return this.agentCache.get(tenantId)!;
  }

  /**
   * Discover A2A agents. In Phase 2, reads from in-memory cache.
   * Phase 3 adds Oracle agent_registry query.
   */
  async discover(filter: A2ADiscoverFilter): Promise<A2AAgentInfo[]> {
    const tenantCache = this.getTenantCache();
    const agents: A2AAgentInfo[] = [];

    for (const [url, card] of tenantCache) {
      const ac = card as any;
      if (filter.status && ac.status !== filter.status) continue;
      if (filter.capability) {
        const skills = ac.skills || [];
        const matches = skills.some(
          (s: any) =>
            s.id?.includes(filter.capability!) ||
            s.description?.includes(filter.capability!) ||
            s.tags?.some((t: string) => t.includes(filter.capability!))
        );
        if (!matches) continue;
      }

      agents.push({
        agentId: ac.name || url,
        name: ac.name || "Unknown",
        url: ac.url || url,
        capabilities: (ac.skills || []).map((s: any) => s.id),
        status: ac.status || "online",
        lastSeen: ac.lastSeen || new Date().toISOString(),
      });
    }

    return agents;
  }

  /**
   * Send a task to a remote A2A agent via JSON-RPC.
   */
  async sendTask(agentUrl: string, toolName: string, params: Record<string, any>): Promise<unknown> {
    const taskId = randomUUID();
    const messageId = randomUUID();

    const request = {
      jsonrpc: "2.0",
      method: "tasks/send",
      params: {
        message: {
          messageId,
          role: "user",
          parts: [{ kind: "text", text: JSON.stringify({ tool: toolName, params }) }],
          kind: "message",
        },
        taskId,
      },
      id: 1,
    };

    const response = await this.jsonRpcCall(agentUrl, request);
    
    // Cache the agent card from response metadata if available
    if (response && typeof response === "object") {
      const r = response as any;
      if (r.result?.agentCard) {
        this.getTenantCache().set(agentUrl, r.result.agentCard); // Use tenant-specific cache
      }
    }

    return response;
  }

  /**
   * Get task status from a remote A2A agent.
   */
  async getTaskStatus(agentUrl: string, taskId: string): Promise<unknown> {
    const request = {
      jsonrpc: "2.0",
      method: "tasks/get",
      params: { taskId },
      id: 1,
    };

    return this.jsonRpcCall(agentUrl, request);
  }

  /**
   * Share context via Dreaming Memory.
   */
  async shareContext(project: string, key: string, value: string, visibility: string): Promise<void> {
    await OracleDreamingService.saveDreamMemory(
      project,
      randomUUID(),
      "A2A_SHARED_CONTEXT" as DreamMemoryType,
      JSON.stringify({
        key,
        value,
        visibility,
        timestamp: new Date().toISOString(),
      }),
      5 // importance — medium
    );
    logger.info(`[A2A] Shared context: ${key} → ${project} (${visibility})`);
  }

  /**
   * Register a discovered agent in the local cache.
   */
  registerAgent(url: string, agentCard: unknown): void {
    this.getTenantCache().set(url, agentCard); // Use tenant-specific cache
    logger.info(`[A2A] Registered agent: ${url}`);
  }

  /**
   * Make a JSON-RPC 2.0 call to a remote agent.
   */
  private async jsonRpcCall(agentUrl: string, request: unknown): Promise<unknown> {
    const jsonRpcUrl = agentUrl.endsWith("/jsonrpc")
      ? agentUrl
      : agentUrl.endsWith("/a2a")
        ? `${agentUrl}/jsonrpc`
        : `${agentUrl.replace(/\/$/, "")}/a2a/jsonrpc`;

    const body = JSON.stringify(request);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const auth = authStorage.getStore();
    // Build auth headers for remote A2A calls — prefer scoped token then API key
    let headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.A2A_MCP_TOKEN) {
      headers["Authorization"] = `Bearer ${process.env.A2A_MCP_TOKEN}`;
    } else if (process.env.CODEATLAS_API_KEY) {
      headers["x-api-key"] = process.env.CODEATLAS_API_KEY;
    }

    try {
      const response = await fetch(jsonRpcUrl, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Singleton A2A client service */
export const a2aClientService = new A2AClientService();
