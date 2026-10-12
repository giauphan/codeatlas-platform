import { AnalysisResult, GraphNode } from "../../types/index.js";
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

// ⚡ Bolt Optimization: Extracted arrays and static Regex objects to module scope and converted to Sets
// where applicable (for O(1) matching). This prevents them from being redundantly recreated during
// every single AST node iteration when scanning large codebases, significantly boosting scanner throughput.
const REGEX_WITH_SLASH = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|[_./-]/;
const REGEX_WITHOUT_SLASH = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|[_.-]/;

const UNSAFE_FUNCS = new Set([
  "eval",
  "exec",
  "system",
  "child_process",
  "spawn",
  "shell_exec",
]);

const DB_KEYWORDS = [
  "db",
  "database",
  "repository",
  "model",
  "oracle",
  "postgres",
  "mysql",
  "sqlite",
  "sql",
  "connection",
  "pool",
  "transaction",
];

const NON_SECRET_SUBSTRINGS = new Set([
  "expired", "count", "length", "type", "url", "path", "status",
  "valid", "error", "failed", "success", "check", "verify",
  "duration", "limit", "payload", "header", "name", "id",
  "store", "storage", "service", "provider", "client",
]);

const SECRET_KEYWORDS = new Set([
  "secret", "password", "token", "credential", "bearer", "apikey"
]);

const KEY_MODIFIERS = new Set([
  "api", "private", "access", "secret", "encryption", "decryption", "auth", "session"
]);

// Helper to extract words from a camelCase, snake_case, or kebab-case string
const extractWords = (text: string, includeSlash: boolean = false): string[] => {
  const regex = includeSlash ? REGEX_WITH_SLASH : REGEX_WITHOUT_SLASH;
  return text.split(regex).map((p) => p.toLowerCase());
};

export class SecurityScanner {
  /**
   * Scan an analyzed project for security vulnerabilities
   */
  static scan(analysis: AnalysisResult): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const nodes = analysis.graph.nodes;

    const nodesMap = new Map(nodes.map((n: GraphNode) => [n.id, n]));

    // Pre-compute an adjacency list to avoid O(N*L) lookups inside isSqlRelated
    const linkMap = new Map<string, Set<string>>();
    analysis.graph.links.forEach((link) => {
      if (!linkMap.has(link.source)) linkMap.set(link.source, new Set());
      if (!linkMap.has(link.target)) linkMap.set(link.target, new Set());
      linkMap.get(link.source)!.add(link.target);
      linkMap.get(link.target)!.add(link.source);
    });

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

    // Helper to detect if a variable name represents a real security secret/token/password
    const isSecretVariable = (label: string): boolean => {
      const parts = extractWords(label);

      // If the label contains any non-secret metadata word, skip it to prevent false positives
      if (parts.some((part) => NON_SECRET_SUBSTRINGS.has(part))) {
        return false;
      }

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (SECRET_KEYWORDS.has(part)) {
          return true;
        }
        if (part === "key") {
          // Verify if it is preceded or followed by security-relevant context
          if (i > 0 && KEY_MODIFIERS.has(parts[i - 1])) {
            return true;
          }
          if (i < parts.length - 1 && KEY_MODIFIERS.has(parts[i + 1])) {
            return true;
          }
        }
      }
      return false;
    };

    // Helper to verify if a function is actually SQL/Database related to avoid false-positive SQL injection warnings
    const isSqlRelated = (node: GraphNode): boolean => {
      // 1. Check file path
      const fp = (node.filePath || "").toLowerCase();
      if (DB_KEYWORDS.some((k) => fp.includes(k))) {
        return true;
      }

      // 2. Check node label itself
      const labelLower = node.label.toLowerCase();
      if (DB_KEYWORDS.some((k) => labelLower.includes(k))) {
        return true;
      }

      // 3. Check connected nodes (incoming / outgoing calls or imports) using the pre-computed adjacency list
      const connectedNodeIds = linkMap.get(node.id) || new Set<string>();

      for (const id of connectedNodeIds) {
        const otherNode = nodesMap.get(id);
        if (otherNode) {
          const otherLabel = otherNode.label.toLowerCase();
          const otherFp = (otherNode.filePath || "").toLowerCase();
          if (
            DB_KEYWORDS.some(
              (k) => otherLabel.includes(k) || otherFp.includes(k),
            )
          ) {
            return true;
          }
        }
      }

      return false;
    };

    nodes.forEach((node: GraphNode) => {
      const filePath = node.filePath;
      if (filePath && isTestOrMockFile(filePath)) {
        return;
      }

      const labelLower = node.label.toLowerCase();

      // 1. Detect Hardcoded Secrets
      if (node.type === "variable") {
        if (isSecretVariable(node.label)) {
          findings.push({
            severity: "HIGH",
            type: "HARDCODED_SECRET",
            message: `Potential hardcoded secret found in variable: ${node.label}`,
            filePath: filePath || "unknown",
            line: node.line || null,
          });
        }
      }

      // 2. Detect Unsafe Functions (eval, exec, etc.)
      else if (node.type === "function") {
        if (UNSAFE_FUNCS.has(labelLower)) {
          findings.push({
            severity: "CRITICAL",
            type: "UNSAFE_FUNCTION",
            message: `Use of potentially dangerous function: ${node.label}`,
            filePath: filePath || "unknown",
            line: node.line || null,
          });
        }

        // 3. Detect Potential SQL Injection
        if (
          (node.label.includes("Query") || node.label.includes("execute") ||
           labelLower.includes("select") || labelLower.includes("insert") ||
           labelLower.includes("update") || labelLower.includes("delete") ||
           labelLower.includes("drop") || labelLower.includes("alter")) &&
          node.label !== "execute" &&
          !node.label.endsWith("UseCase") &&
          isSqlRelated(node)
        ) {
          findings.push({
            severity: "MEDIUM",
            type: "SQL_INJECTION_RISK",
            message: `Potential SQL Injection risk in database call: ${node.label}. Ensure parameterized queries are used.`,
            filePath: filePath || "unknown",
            line: node.line || null,
          });
        }
      }
    });

    return findings;
  }
}
