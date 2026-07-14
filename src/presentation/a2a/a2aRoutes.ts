/**
 * A2A Express Routes
 * Mounts:
 *   GET  /.well-known/agent-card.json  — Agent discovery
 *   POST /a2a/jsonrpc                  — JSON-RPC 2.0 endpoint
 *   POST /a2a/rest/message             — REST convenience endpoint
 */

import express from "express";
import { buildAgentCard } from "./agentCard.js";
import { A2AExecutor } from "./a2aExecutor.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../../types/a2a.js";
import { randomUUID } from "node:crypto";
import { logger } from "../../utils/logger.js";
import { authMiddleware } from "../../middleware/auth.js";

export function mountA2ARoutes(app: express.Express, executor: A2AExecutor, baseUrl: string): void {
  // === Agent Discovery ===
  app.get("/.well-known/agent-card.json", (_req, res) => {
    const card = buildAgentCard(baseUrl);
    res.json(card);
  });

  // Also serve at alternate path for compatibility
  app.get("/a2a/agent-card", (_req, res) => {
    const card = buildAgentCard(baseUrl);
    res.json(card);
  });

  // === JSON-RPC 2.0 Endpoint ===
  app.post("/a2a/jsonrpc", authMiddleware, async (req, res) => {
    const body = req.body as JsonRpcRequest;

    // Validate JSON-RPC envelope
    if (!body || body.jsonrpc !== "2.0") {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid Request: not JSON-RPC 2.0" },
        id: null,
      } as JsonRpcResponse);
      return;
    }

    if (!body.method) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid Request: missing method" },
        id: body.id || null,
      } as JsonRpcResponse);
      return;
    }

    try {
      const response = await executor.handleJsonRpc(body);
      res.json(response);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[A2A Routes] JSON-RPC handler error: ${message}`);
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: `Internal error: ${message}` },
        id: body.id || null,
      } as JsonRpcResponse);
    }
  });

  // === REST Convenience Endpoint ===
  app.post("/a2a/rest/message", authMiddleware, async (req, res) => {
    const { message, taskId } = req.body || {};

    if (!message || !message.parts) {
      res.status(400).json({ error: "Missing 'message' with 'parts' array" });
      return;
    }

    // Build a standard JSON-RPC tasks/send call internally
    const jsonRpcRequest: JsonRpcRequest = {
      jsonrpc: "2.0",
      method: "tasks/send",
      params: { message, taskId: taskId || randomUUID() },
      id: 1,
    };

    const response = await executor.handleJsonRpc(jsonRpcRequest);
    res.json(response);
  });

  // === Health check ===
  app.get("/a2a/health", (_req, res) => {
    res.json({
      status: "ok",
      protocol: "A2A",
      version: "0.3.0",
      server: "CodeAtlas AI",
    });
  });

  logger.info(`[A2A] Routes mounted — Agent Card: ${baseUrl}/.well-known/agent-card.json`);
  logger.info(`[A2A] JSON-RPC: ${baseUrl}/a2a/jsonrpc`);
}
