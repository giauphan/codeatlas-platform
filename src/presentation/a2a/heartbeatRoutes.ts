/**
 * A2A Heartbeat Routes
 * Lightweight endpoint for agent liveness tracking.
 * 
 * GET  /a2a/register?agent_url=...  — Register agent
 * POST /a2a/heartbeat               — Ping to keep alive
 * GET  /a2a/agents                  — List agents
 */

import express from "express";
import { a2aRegistry } from "../../services/a2aRegistry.js";
import { logger } from "../../utils/logger.js";

export function mountHeartbeatRoutes(app: express.Express): void {

  // Register an agent
  app.get("/a2a/register", (req, res) => {
    const agentUrl = req.query.agent_url as string;
    const agentName = req.query.agent_name as string || "Unknown Agent";
    const capabilities = (req.query.capabilities as string || "").split(",").filter(Boolean);

    if (!agentUrl) {
      res.status(400).json({ error: "Missing agent_url parameter" });
      return;
    }

    const agentId = agentName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    a2aRegistry.register({
      agentId, agentUrl, agentName, capabilities,
      status: "online",
      lastHeartbeat: new Date(),
      registeredAt: new Date(),
    });

    logger.info(`[A2A Heartbeat] Agent registered: ${agentName} (${agentUrl})`);
    res.json({ status: "registered", agentId, agentUrl });
  });

  // Heartbeat ping
  app.post("/a2a/heartbeat", (req, res) => {
    const { agent_url } = req.body || {};
    if (!agent_url) {
      res.status(400).json({ error: "Missing agent_url" });
      return;
    }
    a2aRegistry.heartbeat(agent_url);
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // List agents
  app.get("/a2a/agents", async (_req, res) => {
    const records = await a2aRegistry.listAll();
    const agents = records.map(r => ({
      agentId: r.agentId,
      name: r.agentName,
      url: r.agentUrl,
      capabilities: r.capabilities,
      status: r.status,
      lastHeartbeat: r.lastHeartbeat.toISOString(),
      registeredAt: r.registeredAt.toISOString(),
    }));

    res.json({
      agentCount: agents.length,
      onlineCount: agents.filter(a => a.status === "online").length,
      agents: agents.sort((a, b) => a.status === "online" ? -1 : 1),
    });
  });

  logger.info("[A2A Heartbeat] Routes mounted: /a2a/register, /a2a/heartbeat, /a2a/agents");
}
