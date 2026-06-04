import { AnalysisResult, GraphNode } from "./services/types.js";
import * as path from "path";

export interface SecurityFinding {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  type: string;
  message: string;
  filePath: string;
  line: number | null;
  snippet?: string;
  project?: string;
}

export class SecurityScanner {
  /**
   * Scan an analyzed project for security vulnerabilities
   */
  static scan(analysis: AnalysisResult): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const nodes = analysis.graph.nodes;

    const secretKeywords = ["api_key", "secret", "password", "token", "private_key", "access_key"];
    const unsafeFuncs = ["eval", "exec", "system", "child_process", "spawn", "shell_exec"];

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

    nodes.forEach((node: GraphNode) => {
      const filePath = node.filePath;
      if (filePath && isTestOrMockFile(filePath)) {
        return;
      }

      const labelLower = node.label.toLowerCase();

      // 1. Detect Hardcoded Secrets
      if (node.type === "variable") {
        if (secretKeywords.some(k => labelLower.includes(k))) {
          findings.push({
            severity: "HIGH",
            type: "HARDCODED_SECRET",
            message: `Potential hardcoded secret found in variable: ${node.label}`,
            filePath: filePath || "unknown",
            line: node.line || null
          });
        }
      }

      // 2. Detect Unsafe Functions (eval, exec, etc.)
      else if (node.type === "function") {
        if (unsafeFuncs.includes(labelLower)) {
          findings.push({
            severity: "CRITICAL",
            type: "UNSAFE_FUNCTION",
            message: `Use of potentially dangerous function: ${node.label}`,
            filePath: filePath || "unknown",
            line: node.line || null
          });
        }

        // 3. Detect Potential SQL Injection
        if (
          (node.label.includes("Query") || node.label.includes("execute")) &&
          node.label !== "execute" &&
          !node.label.endsWith("UseCase")
        ) {
          findings.push({
            severity: "MEDIUM",
            type: "SQL_INJECTION_RISK",
            message: `Potential SQL Injection risk in database call: ${node.label}. Ensure parameterized queries are used.`,
            filePath: filePath || "unknown",
            line: node.line || null
          });
        }
      }
    });

    return findings;
  }
}
