import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isToolEnabled } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Wraps an McpServer instance to intercept tool registrations.
 * If a tool is listed in CODEATLAS_DISABLED_TOOLS (and is not protected),
 * the registration will be silently ignored.
 */
export function wrapServerWithToolFilter(server: McpServer): McpServer {
  const originalTool = server.tool.bind(server);

  // Replace the tool registration method.
  // We use `any` here because McpServer.tool has complex method overloads for
  // (name, cb), (name, desc, cb), (name, schema, cb), (name, desc, schema, cb).
  server.tool = (name: string, ...args: any[]): any => {
    if (!isToolEnabled(name)) {
      logger.info(`[MCP] Tool disabled by configuration: ${name}`);
      return server; // return server instance to support potential chaining
    }
    return (originalTool as any)(name, ...args);
  };

  return server;
}