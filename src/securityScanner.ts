import { AnalysisResult, GraphNode } from "./services/types.js";
import * as path from "path";

export interface SecurityFinding {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  type: string;
  message: string;
  filePath: string;
  line: number | null;
  snippet?: string;
}

export class SecurityScanner {
  /**
   * Scan an analyzed project for security vulnerabilities
   */
  static scan(analysis: AnalysisResult): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const nodes = analysis.graph.nodes;

    // Helper to identify test, mock or diagnostic files
    const isTestOrMockFile = (filePath: string): boolean => {
      const fp = filePath.toLowerCase().replace(/\\/g, "/");
      return (
        fp.includes("/tests/") ||
        fp.includes("/test/") ||
        fp.includes("/__tests__/") ||
        fp.includes(".test.") ||
        fp.includes(".spec.") ||
        fp.includes("/mocks/") ||
        fp.includes("/mock/") ||
        fp.includes("/scratch/") ||
        fp.includes("/diagnostic/")
      );
    };

    // 1. Detect Hardcoded Secrets
    const secretKeywords = ["api_key", "secret", "password", "token", "private_key", "access_key"];
    nodes.forEach((node: GraphNode) => {
      if (node.type === "variable") {
        if (node.filePath && isTestOrMockFile(node.filePath)) {
          return;
        }

        const name = node.label.toLowerCase();
        if (secretKeywords.some(k => name.includes(k))) {
          findings.push({
            severity: "HIGH",
            type: "HARDCODED_SECRET",
            message: `Potential hardcoded secret found in variable: ${node.label}`,
            filePath: node.filePath || "unknown",
            line: node.line || null
          });
        }
      }
    });

    // 2. Detect Unsafe Functions (eval, exec, etc.)
    const unsafeFuncs = ["eval", "exec", "system", "child_process", "spawn", "shell_exec"];
    nodes.forEach((node: GraphNode) => {
      if (node.type === "function") {
        if (node.filePath && isTestOrMockFile(node.filePath)) {
          return;
        }

        const name = node.label.toLowerCase();
        if (unsafeFuncs.includes(name)) {
          findings.push({
            severity: "CRITICAL",
            type: "UNSAFE_FUNCTION",
            message: `Use of potentially dangerous function: ${node.label}`,
            filePath: node.filePath || "unknown",
            line: node.line || null
          });
        }
      }
    });

    // 3. Detect Potential SQL Injection
    // Look for functions containing "query" or "execute" that are connected to variables
    // (Simplified heuristic for static analysis)
    nodes.forEach((node: GraphNode) => {
      if (node.type === "function" && (node.label.includes("Query") || node.label.includes("execute"))) {
        if (node.filePath && isTestOrMockFile(node.filePath)) {
          return;
        }

        // Avoid UseCase classes (Command pattern)
        if (node.label === "execute" || node.label.endsWith("UseCase")) {
          return;
        }

        findings.push({
          severity: "MEDIUM",
          type: "SQL_INJECTION_RISK",
          message: `Potential SQL Injection risk in database call: ${node.label}. Ensure parameterized queries are used.`,
          filePath: node.filePath || "unknown",
          line: node.line || null
        });
      }
    });

    // 4. Detect Insecure Protocols (http vs https)
    // (Could be expanded by looking at string constants if we had them)

    return findings;
  }
}
