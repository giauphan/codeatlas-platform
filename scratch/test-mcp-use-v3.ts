import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function useMcpServer() {
  const apiKey = "ca_7d94a7d627324b79870c77e3307190ce";
  const url = new URL("https://atlas.genrostore.com/sse");
  url.searchParams.set("apiKey", apiKey);

  console.log(`Connecting to production MCP server to execute tools...`);
  
  const transport = new SSEClientTransport(url);
  const client = new Client(
    {
      name: "CodeAtlas-Mcp-Operator",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  try {
    await client.connect(transport);
    console.log("Connected successfully! Executing tools...\n");

    // 1. Call list_projects
    console.log("--- Calling tool 'list_projects' ---");
    const projectsResponse = await client.callTool({
      name: "list_projects",
      arguments: {}
    });
    console.log("Result:");
    console.log(JSON.stringify(projectsResponse.content, null, 2));

    // 2. Call get_insights for the active project
    console.log("\n--- Calling tool 'get_insights' for project 'codeatlas-ai' ---");
    const insightsResponse = await client.callTool({
      name: "get_insights",
      arguments: {
        projectId: "codeatlas-ai"
      }
    });
    console.log("Result:");
    console.log(JSON.stringify(insightsResponse.content, null, 2));

    console.log("\nMCP Tools executed and verified successfully on production!");
    
    await client.close();
  } catch (err: any) {
    console.error("Failed to execute MCP tools:", err.message || err);
  }
}

useMcpServer();
