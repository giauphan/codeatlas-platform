import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./mcpTools.js";
import { registerA2ATools } from "./a2a/a2aTools.js";
import { wrapServerWithToolFilter } from "./toolFilter.js";

export function createMcpServer(sessionAuth?: { tier: string; uid: string; keyId: string }): McpServer {
  const instance = wrapServerWithToolFilter(new McpServer(
    {
      name: "CodeAtlas",
      version: "2.14.4",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
        logging: {},
      },
    },
  ));

  registerTools(instance, sessionAuth);
  registerA2ATools(instance, sessionAuth);
  return instance;
}

// Keep the importable server unauthenticated; transports bind validated sessions.
export const server = createMcpServer();
