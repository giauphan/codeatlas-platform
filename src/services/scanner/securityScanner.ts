import { AnalysisResult, GraphNode } from "../../types/index.js";


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
const DB_KEYWORDS_REGEX = new RegExp(DB_KEYWORDS.join("|"));
const TEST_MOCK_FILE_REGEX = /\/tests\/|\/test\/|\/__tests__\/|\.test\.|\.spec\.|\/mocks\/|\/mock\/|\/scratch\/|\/diagnostic\//;
const SQL_INJECTION_RISK_REGEX = /select|insert|update|delete|drop|alter/;

const NON_SECRET_SUBSTRINGS = new Set([
  "expired",
  "count",
  "length",
  "type",
  "url",
  "path",
  "status",
  "valid",
  "error",
  "failed",
  "success",
  "check",
  "verify",
  "duration",
  "limit",
  "payload",
  "header",
  "name",
  "id",
  "store",
  "storage",
  "service",
  "provider",
  "client",
]);

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

    const nodesMap = new Map(nodes.map((n: GraphNode) => [n.id, n]));

    // Pre-compute an adjacency list to avoid O(N*L) lookups inside isSqlRelated
    const linkMap = new Map<string, Set<string>>();
    analysis.graph.links.forEach((link) => {
      if (!linkMap.has(link.source)) linkMap.set(link.source, new Set());
      if (!linkMap.has(link.target)) linkMap.set(link.target, new Set());
      linkMap.get(link.source)!.add(link.target);
      linkMap.get(link.target)!.add(link.source);
    });

    // Helper to extract words from a camelCase, snake_case, or kebab-case string
    const extractWords = (text: string, includeSlash: boolean = false): string[] => {
      const regex = includeSlash
        ? /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|[_./-]/
        : /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|[_.-]/;
      return text.split(regex).map((p) => p.toLowerCase());
    };

    // Helper to identify test, mock or diagnostic files
    const isTestOrMockFile = (filePath: string): boolean => {
      const fp = filePath.toLowerCase().replaceAll("\\", "/");
      // ⚡ Bolt Optimization: Replaced O(N) array .includes check with O(1) RegExp .test check
      return TEST_MOCK_FILE_REGEX.test(fp);
    };

    // Helper to detect if a variable name represents a real security secret/token/password
    const isSecretVariable = (label: string): boolean => {
      const parts = extractWords(label);

      // If the label contains any non-secret metadata word, skip it to prevent false positives
      if (parts.some((part) => NON_SECRET_SUBSTRINGS.has(part))) {
        return false;
      }

      const secretWords = new Set(["secret", "password", "token", "credential", "bearer", "apikey"]);
      const keyContext = new Set(["api", "private", "access", "secret", "encryption", "decryption", "auth", "session"]);
      return parts.some((part, index) => secretWords.has(part) ||
        (part === "key" && (keyContext.has(parts[index - 1]) || keyContext.has(parts[index + 1]))));
    };

    // Helper to verify if a function is actually SQL/Database related to avoid false-positive SQL injection warnings
    const isSqlRelated = (node: GraphNode): boolean => {
      // ⚡ Bolt Optimization: Replaced O(N) array .some/.includes with precompiled RegExp .test

      // 1. Check file path
      const fp = (node.filePath || "").toLowerCase();
      if (DB_KEYWORDS_REGEX.test(fp)) {
        return true;
      }

      // 2. Check node label itself
      const labelLower = node.label.toLowerCase();
      if (DB_KEYWORDS_REGEX.test(labelLower)) {
        return true;
      }

      // 3. Check connected nodes (incoming / outgoing calls or imports) using the pre-computed adjacency list
      const connectedNodeIds = linkMap.get(node.id) || new Set<string>();

      for (const id of connectedNodeIds) {
        const otherNode = nodesMap.get(id);
        if (otherNode) {
          const otherLabel = otherNode.label.toLowerCase();
          const otherFp = (otherNode.filePath || "").toLowerCase();
          if (DB_KEYWORDS_REGEX.test(otherLabel) || DB_KEYWORDS_REGEX.test(otherFp)) {
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
           SQL_INJECTION_RISK_REGEX.test(labelLower)) &&
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
