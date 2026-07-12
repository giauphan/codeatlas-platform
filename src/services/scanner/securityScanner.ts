import { AnalysisResult, GraphNode } from "../../types/index.js";
import * as path from "path";
import { logger } from "../../utils/logger.js";

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

    const unsafeFuncs = [
      "eval",
      "exec",
      "system",
      "child_process",
      "spawn",
      "shell_exec",
    ];
    const dbKeywords = [
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
      const parts = label
        .split(/(?<=[a-z])(?=[A-Z])|[_.-]/)
        .map((p) => p.toLowerCase());
      const nonSecretSubstrings = [
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
      ];

      // If the label contains any non-secret metadata word, skip it to prevent false positives
      if (parts.some((part) => nonSecretSubstrings.includes(part))) {
        return false;
      }

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part === "secret" || part === "password" || part === "token") {
          return true;
        }
        if (part === "key") {
          // Verify if it is preceded or followed by security-relevant context
          if (i > 0) {
            const prev = parts[i - 1];
            if (
              prev === "api" ||
              prev === "private" ||
              prev === "access" ||
              prev === "secret" ||
              prev === "encryption" ||
              prev === "decryption" ||
              prev === "auth" ||
              prev === "session"
            ) {
              return true;
            }
          }
          if (i < parts.length - 1) {
            const next = parts[i + 1];
            if (
              next === "api" ||
              next === "private" ||
              next === "access" ||
              next === "secret" ||
              next === "encryption" ||
              next === "decryption" ||
              next === "auth" ||
              next === "session"
            ) {
              return true;
            }
          }
        }
      }
      return false;
    };

    // Helper to verify if a function is actually SQL/Database related to avoid false-positive SQL injection warnings
    const isSqlRelated = (node: GraphNode): boolean => {
      // 1. Check file path
      const fp = (node.filePath || "").toLowerCase();
      if (dbKeywords.some((k) => fp.includes(k))) {
        return true;
      }

      // 2. Check node label itself
      const labelLower = node.label.toLowerCase();
      if (dbKeywords.some((k) => labelLower.includes(k))) {
        return true;
      }

      // 3. Check connected nodes (incoming / outgoing calls or imports)
      const connectedNodeIds = new Set<string>();
      analysis.graph.links.forEach((link) => {
        if (link.source === node.id) {
          connectedNodeIds.add(link.target);
        } else if (link.target === node.id) {
          connectedNodeIds.add(link.source);
        }
      });

      for (const id of connectedNodeIds) {
        const otherNode = nodesMap.get(id);
        if (otherNode) {
          const otherLabel = otherNode.label.toLowerCase();
          const otherFp = (otherNode.filePath || "").toLowerCase();
          if (
            dbKeywords.some(
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
        if (unsafeFuncs.includes(labelLower)) {
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
          (node.label.includes("Query") || node.label.includes("execute")) &&
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

  /**
   * AI-powered deep scan using DeepSeek V4 Pro (or configured LLM).
   * Analyzes findings + code context for deeper issues.
   * Configure via: CODEATLAS_SCAN_AI_URL, CODEATLAS_SCAN_AI_KEY, CODEATLAS_SCAN_AI_MODEL
   */
  static async aiScan(findings: SecurityFinding[], analysis: AnalysisResult): Promise<SecurityFinding[]> {
    const aiUrl = process.env.CODEATLAS_SCAN_AI_URL || process.env.OPENCODE_BASE_URL || "";
    const aiKey = process.env.CODEATLAS_SCAN_AI_KEY || process.env.OPENCODE_API_KEY || "";
    const aiModel = process.env.CODEATLAS_SCAN_AI_MODEL || "deepseek-v4-pro";

    if (!aiUrl || !aiKey) {
      logger.info("[SecurityScanner] AI scan not configured — skipping LLM deep analysis");
      return findings;
    }

    try {
      // Prepare code context from the most critical findings
      const criticalFindings = findings.filter(f => f.severity === "CRITICAL" || f.severity === "HIGH").slice(0, 5);
      const codeContext = criticalFindings.map(f => {
        const node = analysis.graph.nodes.find(n => n.filePath === f.filePath);
        return `[${f.severity}] ${f.type}: ${f.message} (${f.filePath}:${f.line})`;
      }).join("\n");

      const response = await fetch(aiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${aiKey}`
        },
        body: JSON.stringify({
          model: aiModel,
          messages: [
            {
              role: "system",
              content: "You are a security code analyzer. Analyze the following findings and provide deeper insights. Respond ONLY with valid JSON array of objects: [{\"severity\":\"...\",\"type\":\"...\",\"message\":\"...\",\"filePath\":\"...\",\"line\":0}]. Empty array if no additional issues."
            },
            {
              role: "user",
              content: `Static analysis found these issues:\n${codeContext}\n\nAnalyze the codebase context and identify any deeper issues not caught by static patterns. Focus on logic bugs, race conditions, and architectural smells.`
            }
          ],
          temperature: 0.1,
          max_tokens: 1024
        })
      });

      if (!response.ok) {
        logger.warn(`[SecurityScanner] AI scan API returned ${response.status}`);
        return findings;
      }

      const data = await response.json() as any;
      const aiFindings: SecurityFinding[] = data.choices?.[0]?.message?.content
        ? JSON.parse(data.choices[0].message.content.replace(/```json|```/g, "").trim())
        : [];

      logger.info(`[SecurityScanner] AI scan found ${aiFindings.length} additional issues`);
      return [...findings, ...aiFindings];
    } catch (err) {
      logger.warn("[SecurityScanner] AI scan failed:", err instanceof Error ? err.message : String(err));
      return findings;
    }
  }
}
