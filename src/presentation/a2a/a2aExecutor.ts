/**
 * A2A Agent Executor — JSON-RPC 2.0 handler
 * Implements the A2A task execution loop:
 *   1. Receive user message (tool name + params)
 *   2. Dispatch to MCP tool
 *   3. Return result as task artifact
 *
 * Pure implementation — no @a2a-js/sdk dependency.
 */

import { randomUUID } from "node:crypto";
import type {
  Message,
  Task,
  Artifact,
  Part,
  TextPart,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../../types/a2a.js";
import { logger } from "../../utils/logger.js";

export class A2AExecutor {
  /** In-memory task store */
  private tasks = new Map<string, Task>();
  /** MCP tool dispatch map */
  private toolHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();

  /**
   * Register an MCP tool handler so A2A can call it by name.
   */
  registerToolHandler(name: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void {
    this.toolHandlers.set(name, handler);
  }

  /**
   * Handle a JSON-RPC 2.0 request.
   * Supports methods: tasks/send, tasks/get, tools/list
   */
  async handleJsonRpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { method, params, id } = request;

    try {
      switch (method) {
        case "tasks/send":
          return this.handleTasksSend(params || {}, id);
        case "tasks/get":
          return this.handleTasksGet(params || {}, id);
        case "tools/list":
          return this.handleToolsList(id);
        default:
          return this.errorResponse(id, -32601, `Method not found: ${method}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[A2A] JSON-RPC error in ${method}: ${message}`);
      return this.errorResponse(id, -32000, message);
    }
  }

  /**
   * tasks/send — the core A2A method. User sends a message, we execute a tool, return a task.
   */
  private async handleTasksSend(params: Record<string, unknown>, id: string | number): Promise<JsonRpcResponse> {
    const taskId = (params.taskId as string) || randomUUID();
    const contextId = (params.contextId as string) || randomUUID();

    // Extract user message
    const messageParam = params.message as Record<string, unknown> | undefined;
    if (!messageParam) {
      return this.errorResponse(id, -32602, "Missing 'message' parameter");
    }

    const message: Message = {
      kind: "message",
      messageId: (messageParam.messageId as string) || randomUUID(),
      role: "user",
      parts: (messageParam.parts as Part[]) || [],
      contextId,
      taskId,
    };

    // Parse what tool to call from the message
    const textPart = message.parts.find((p) => p.kind === "text") as TextPart | undefined;
    const userText = textPart?.text || "";

    const { toolName, toolParams } = this.parseRequest(userText);

    // Create task in working state
    const task: Task = {
      kind: "task",
      id: taskId,
      contextId,
      status: {
        state: "working",
        timestamp: new Date().toISOString(),
      },
      history: [message],
      artifacts: [],
    };
    this.tasks.set(taskId, task);

    // Execute the MCP tool
    try {
      const result = await this.callTool(toolName, toolParams);
      const resultText = typeof result === "string" ? result : JSON.stringify(result, null, 2);

      const artifact: Artifact = {
        artifactId: randomUUID(),
        name: `${toolName}-result.json`,
        parts: [{ kind: "text", text: resultText }],
      };

      task.artifacts = task.artifacts ? [...task.artifacts, artifact] : [artifact];
      task.status = {
        state: "completed",
        timestamp: new Date().toISOString(),
      };
      this.tasks.set(taskId, task);

      return {
        jsonrpc: "2.0",
        result: task,
        id,
      };
    } catch (execErr: unknown) {
      const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
      task.status = {
        state: "failed",
        timestamp: new Date().toISOString(),
        message: {
          kind: "message",
          messageId: randomUUID(),
          role: "agent",
          parts: [{ kind: "text", text: `Tool execution failed: ${errMsg}` }],
          contextId,
          taskId,
        },
      };
      this.tasks.set(taskId, task);

      return {
        jsonrpc: "2.0",
        result: task,
        id,
      };
    }
  }

  /**
   * tasks/get — retrieve task status by ID.
   */
  private handleTasksGet(params: Record<string, unknown>, id: string | number): JsonRpcResponse {
    const taskId = params.taskId as string;
    if (!taskId) {
      return this.errorResponse(id, -32602, "Missing 'taskId' parameter");
    }

    const task = this.tasks.get(taskId);
    if (!task) {
      return this.errorResponse(id, -32001, `Task not found: ${taskId}`);
    }

    return {
      jsonrpc: "2.0",
      result: task,
      id,
    };
  }

  /**
   * tools/list — return available tools (A2A skill list).
   */
  private handleToolsList(id: string | number): JsonRpcResponse {
    const tools = Array.from(this.toolHandlers.keys()).map((name) => ({
      name,
      description: `MCP tool: ${name}`,
    }));

    return {
      jsonrpc: "2.0",
      result: { tools },
      id,
    };
  }

  /**
   * Parse user text to extract tool name and params.
   * Format: JSON { "tool": "search_entities", "params": { "query": "..." } }
   * Fallback: plain text → try first word as tool name
   */
  private parseRequest(text: string): { toolName: string; toolParams: Record<string, unknown> } {
    // Try JSON parse
    try {
      const obj = JSON.parse(text);
      if (obj.tool && typeof obj.tool === "string") {
        return {
          toolName: obj.tool,
          toolParams: obj.params || {},
        };
      }
    } catch {
      // Not JSON, try natural language
    }

    // Fallback: if text matches a registered tool name, use it
    const words = text.trim().split(/\s+/);
    const maybeTool = words[0]?.replace(/[^a-zA-Z0-9_]/g, "");
    if (maybeTool && this.toolHandlers.has(maybeTool)) {
      return { toolName: maybeTool, toolParams: { query: words.slice(1).join(" ") } };
    }

    // Default: list projects
    return { toolName: "list_projects", toolParams: {} };
  }

  /**
   * Dispatch to an MCP tool by name.
   */
  private async callTool(name: string, params: Record<string, unknown>): Promise<unknown> {
    const handler = this.toolHandlers.get(name);
    if (!handler) {
      // Return available tools as helpful error
      const available = Array.from(this.toolHandlers.keys()).join(", ");
      return {
        error: `Tool '${name}' not found. Available tools: ${available}`,
        availableTools: Array.from(this.toolHandlers.keys()),
      };
    }

    return handler(params);
  }

  /**
   * Build standard JSON-RPC error response.
   */
  private errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      error: { code, message },
      id,
    };
  }

  /**
   * Clean up a task from the store (for memory management).
   */
  cleanupTask(taskId: string): void {
    this.tasks.delete(taskId);
  }
}

/** Singleton A2A executor shared across MCP tools and HTTP routes */
export const a2aExecutor = new A2AExecutor();
