/**
 * A2A Agent Registry Service
 * Oracle 26ai-backed registry for A2A agent discovery.
 * 
 * Features:
 * - Register agents by URL + AgentCard
 * - Heartbeat tracking for liveness
 * - Query by capability keyword
 * - Auto-mark stale agents offline
 * 
 * Fallback: in-memory if Oracle is not configured.
 */

import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";

export interface A2AAgentRecord {
  agentId: string;
  agentUrl: string;
  agentName: string;
  capabilities: string[];
  status: "online" | "offline" | "busy" | "degraded";
  lastHeartbeat: Date;
  registeredAt: Date;
  agentCardJson?: string;
  metadata?: Record<string, unknown>;
}

export interface A2ADiscoverQuery {
  capability?: string;
  status?: string;
  limit?: number;
}

/** In-memory fallback when Oracle is unavailable */
const memoryStore = new Map<string, A2AAgentRecord>();

/** Timeout after which agents are considered offline */
const STALE_TIMEOUT_MS = 120_000; // 2 minutes

export class A2ARegistry {
  private useOracle = false;

  constructor() {
    if (process.env.ORACLE_CONN_STRING) {
      this.useOracle = true;
      logger.info("[A2A Registry] Oracle backend available for agent registry");
    } else {
      logger.info("[A2A Registry] Using in-memory store (Oracle not configured)");
    }
  }

  /**
   * Register or update an agent in the registry.
   */
  async register(record: A2AAgentRecord): Promise<string> {
    const agentId = record.agentId || this.slugify(record.agentName);

    if (this.useOracle) {
      try {
        await this.oracleUpsert(agentId, record);
      } catch (err) {
        logger.error(`[A2A Registry] Oracle upsert failed, falling back to memory: ${err}`);
      }
    }

    // Always update in-memory cache
    const existing = memoryStore.get(agentId);
    memoryStore.set(agentId, {
      ...record,
      agentId,
      lastHeartbeat: new Date(),
      registeredAt: existing?.registeredAt || new Date(),
    });

    return agentId;
  }

  /**
   * Heartbeat — update last seen timestamp.
   */
  async heartbeat(agentUrl: string): Promise<void> {
    // Find by URL in memory store
    for (const [id, record] of memoryStore) {
      if (record.agentUrl === agentUrl) {
        record.lastHeartbeat = new Date();
        record.status = "online";
        return;
      }
    }

    // Auto-register unknown agents
    const agentId = `auto-${this.slugify(agentUrl)}`;
    memoryStore.set(agentId, {
      agentId,
      agentUrl,
      agentName: agentUrl,
      capabilities: [],
      status: "online",
      lastHeartbeat: new Date(),
      registeredAt: new Date(),
    });
  }

  /**
   * Query agents by capability keyword and status.
   */
  async query(query: A2ADiscoverQuery = {}): Promise<A2AAgentRecord[]> {
    this.markStale();

    const results: A2AAgentRecord[] = [];
    const capability = query.capability?.toLowerCase();
    const status = query.status || "online";
    const limit = query.limit || 50;

    for (const [, record] of memoryStore) {
      if (status !== "all" && record.status !== status) continue;

      if (capability) {
        const matches = record.capabilities.some(
          (c) => c.toLowerCase().includes(capability)
        );
        if (!matches) continue;
      }

      results.push({ ...record });
    }

    return results.slice(0, limit);
  }

  /**
   * List all registered agents.
   */
  async listAll(): Promise<A2AAgentRecord[]> {
    this.markStale();
    return Array.from(memoryStore.values()).map(r => ({ ...r }));
  }

  /**
   * Mark agents offline if heartbeat is stale.
   */
  private markStale(): void {
    const now = Date.now();
    for (const [, record] of memoryStore) {
      if (now - record.lastHeartbeat.getTime() > STALE_TIMEOUT_MS) {
        record.status = "offline";
      }
    }
  }

  /**
   * Oracle upsert (placeholder — actual implementation depends on connection setup).
   */
  private async oracleUpsert(agentId: string, record: A2AAgentRecord): Promise<void> {
    // Oracle integration — uses same connection pool as other services
    // MERGE INTO agent_registry ...
    logger.debug(`[A2A Registry] Oracle upsert: ${agentId}`);
  }

  /**
   * Create a URL-safe slug from a name.
   */
  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64);
  }
}

/** Singleton registry instance */
export const a2aRegistry = new A2ARegistry();
