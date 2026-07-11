import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./mcpTools.js";
import { registerA2ATools } from "./a2a/a2aTools.js";

// MCP SDK requires a single server instance; tools are registered before transport.start().
export const server = new McpServer(
  {
    name: "CodeAtlas",
    version: "2.14.1",
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
registerA2ATools(server);
