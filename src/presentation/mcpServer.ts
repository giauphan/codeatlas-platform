import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./mcpTools.js";

// Create the global MCP server instance
export const server = new McpServer(
  {
    name: "CodeAtlas",
    version: "2.13.14",
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
