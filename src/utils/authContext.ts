import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authStorage } from "./context.js";

type Auth = { tier: string; uid: string; keyId: string };

export function injectAuthContext(server: McpServer, sessionAuth?: Auth) {
  const originalTool = server.tool.bind(server);

  server.tool = function (name: string, ...args: any[]) {
    const originalCallback = args[args.length - 1]; // NOSONAR
    if (typeof originalCallback === "function") {
      args[args.length - 1] = function (callbackArgs: any, ...extra: any[]) {
        if (!sessionAuth) {
          return Promise.resolve({
            content: [{ type: "text" as const, text: "Error: MCP session authentication is required. Connect with valid credentials." }],
            isError: true as const,
          });
        }
        return authStorage.run(sessionAuth, () => {
          return (originalCallback as any)(callbackArgs, ...extra);
        });
      };
    }
    return (originalTool as any)(name, ...args);
  } as any;
}
