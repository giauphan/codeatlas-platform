/**
 * A2A Agent Card Factory
 * Auto-generates Agent Card from MCP tool registry.
 * Serves at /.well-known/agent-card.json per A2A spec v0.3.
 */

import type { AgentCard, AgentSkill, MCPToolMeta } from "../../types/a2a.js";
import { promises as fs } from "fs";
import * as path from "path";

// Global tool registry — populated by mcpTools.ts at registration time
let toolRegistry: MCPToolMeta[] = [];

/**
 * Register an MCP tool's metadata so it appears in the A2A Agent Card.
 * Called from mcpTools.ts after each server.tool() registration.
 */
export function registerTool(meta: MCPToolMeta): void {
  // De-duplicate by name (re-registration on hot-reload is safe)
  const existing = toolRegistry.findIndex((t) => t.name === meta.name);
  if (existing >= 0) {
    toolRegistry[existing] = meta;
  } else {
    toolRegistry.push(meta);
  }
}

/**
 * Build a fully-formed AgentCard from the current MCP tool registry.
 * @param baseUrl - The server's base URL (e.g. "http://localhost:3000")
 */
export async function buildAgentCard(baseUrl: string): Promise<AgentCard> {
  const skills: AgentSkill[] = toolRegistry.map((t) => ({
    id: t.name,
    name: t.name,
    description: t.description.split("\n")[0].trim(),
    tags: ["mcp", "codeatlas", "code-analysis"],
    inputModes: t.params.length > 0 ? ["application/json"] : ["text"],
    outputModes: ["application/json"],
  }));

  return {
    name: "CodeAtlas AI",
    description:
      "AI-powered codebase intelligence platform — semantic code search, dependency graph analysis, " +
      "architectural smell detection, vulnerability scanning, and dreaming memory with vector search.",
    protocolVersion: "0.3.0",
    version: await getPackageVersion(),
    url: `${baseUrl}/a2a/jsonrpc`,
    skills,
    capabilities: {
      pushNotifications: false,
      streaming: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ["text", "application/json"],
    defaultOutputModes: ["application/json"],
    additionalInterfaces: [
      { url: `${baseUrl}/a2a/jsonrpc`, transport: "JSONRPC" },
      { url: `${baseUrl}/a2a/rest`, transport: "HTTP+JSON" },
    ],
    authentication: {
      schemes: ["bearer", "apiKey"],
    },
  };
}

/**
 * Get the current number of registered tools.
 */
export function getToolCount(): number {
  return toolRegistry.length;
}

let cachedPackageVersion: string | undefined;

/**
 * Read version from package.json (npm_package_version is only available in npm scripts).
 */
async function getPackageVersion(): Promise<string> {
  if (cachedPackageVersion !== undefined) {
    return cachedPackageVersion;
  }

  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
    const version = pkg.version || "unknown";
    cachedPackageVersion = version;
    return version;
  } catch {
    cachedPackageVersion = "unknown";
    return "unknown";
  }
}

/**
 * Get all registered tool metadata (for MCP bridge introspection).
 */
export function getTools(): MCPToolMeta[] {
  return [...toolRegistry];
}

/**
 * Clear the package version cache (useful for tests).
 */
export function clearPackageVersionCache(): void {
  cachedPackageVersion = undefined;
}
