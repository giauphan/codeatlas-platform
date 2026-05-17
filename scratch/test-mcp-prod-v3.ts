import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function testConnection() {
  const apiKey = "ca_7d94a7d627324b79870c77e3307190ce";
  const url = new URL("https://atlas.genrostore.com/sse");
  url.searchParams.set("apiKey", apiKey);

  console.log(`Connecting to production server: ${url.toString()}`);
  
  const transport = new SSEClientTransport(url);
  const client = new Client(
    {
      name: "CodeAtlas-Test-Client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  try {
    await client.connect(transport);
    console.log("Connected successfully to production server!");

    // List tools
    const toolsResult = await client.listTools();
    console.log(`Registered tools count on prod: ${toolsResult.tools.length}`);
    console.log("Tools:", toolsResult.tools.map((t: any) => t.name));

    // Try multiple quick reconnections to test the failsafe v2.1.20 fix!
    console.log("\nTesting rapid reconnection failsafe...");
    await client.close();
    
    // Quick reconnect 1
    const transport2 = new SSEClientTransport(url);
    const client2 = new Client({ name: "Test-Client-2", version: "1.0.0" }, { capabilities: {} });
    await client2.connect(transport2);
    console.log("Rapid Reconnect 1: Success!");
    await client2.close();

    // Quick reconnect 2
    const transport3 = new SSEClientTransport(url);
    const client3 = new Client({ name: "Test-Client-3", version: "1.0.0" }, { capabilities: {} });
    await client3.connect(transport3);
    console.log("Rapid Reconnect 2: Success!");
    await client3.close();

    console.log("\nAll connection and rapid reconnection tests PASSED perfectly!");
  } catch (err: any) {
    console.error("Connection failed with error:", err.message || err);
  }
}

testConnection();
