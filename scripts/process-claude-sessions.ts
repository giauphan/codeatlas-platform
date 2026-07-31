#!/usr/bin/env tsx
/**
 * process-claude-sessions.ts — Batch processor for Claude Code CLI sessions.
 *
 * Reads ALL conversation .jsonl files from ~/.claude/projects/,
 * extracts user+assistant transcripts, sends to CodeAtlas ingest-session API
 * for dream extraction.
 *
 * Uses cache file ~/.claude/brain-cache.json to track processed sessions.
 *
 * Usage:
 *   tsx scripts/process-claude-sessions.ts                        # process new sessions only
 *   tsx scripts/process-claude-sessions.ts --force                 # reprocess ALL sessions
 *   tsx scripts/process-claude-sessions.ts --dry-run              # preview without saving
 *   tsx scripts/process-claude-sessions.ts --project hermes-auto   # filter by project dir
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";

// ── Config ──────────────────────────────────────────────────────────────────

const CLAUDE_PROJECTS = path.join(
  process.env.HOME || "/home/ubuntu",
  ".claude",
  "projects",
);
const CACHE_FILE = path.join(
  process.env.HOME || "/home/ubuntu",
  ".claude",
  "brain-cache.claude.json",
);
const API_BASE = process.env.CODEATLAS_API_URL || "http://localhost:8080";
const API_KEY = process.env.CODEATLAS_API_KEY || "";

// ── Types ───────────────────────────────────────────────────────────────────

interface CacheData {
  processedSessions: string[];
  updatedAt: string;
}

interface ClaudeLine {
  type?: string;
  message?: { role: string; content: string | any[] };
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isMeta?: boolean;
}

interface ProjectSession {
  projectDir: string;     // e.g. "-home-ubuntu-codeatlas-platform"
  sessionId: string;      // UUID from filename
  filePath: string;       // full /path/to/file.jsonl
  lineCount: number;
  hasMessages: boolean;
}

// ── Cache ───────────────────────────────────────────────────────────────────

function readCache(): CacheData {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return { processedSessions: [], updatedAt: new Date().toISOString() };
  }
}

function writeCache(cache: CacheData): void {
  cache.updatedAt = new Date().toISOString();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ── Discover session files ──────────────────────────────────────────────────

function discoverSessions(): ProjectSession[] {
  const results: ProjectSession[] = [];

  if (!fs.existsSync(CLAUDE_PROJECTS)) {
    console.error(`[ClaudeDreams] Projects dir not found: ${CLAUDE_PROJECTS}`);
    return results;
  }

  // Walk ~/.claude/projects/<project-dir>/*.jsonl, skip subagents/
  const projectDirs = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true });
  for (const dirent of projectDirs) {
    if (!dirent.isDirectory()) continue;
    const projectPath = path.join(CLAUDE_PROJECTS, dirent.name);

    const files = fs.readdirSync(projectPath);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = path.join(projectPath, file);

      // Skip subagents/ directories
      if (filePath.includes("/subagents/")) continue;

      const sessionId = file.replace(/\.jsonl$/, "");
      // Validate UUID format
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
        continue;
      }

      const stat = fs.statSync(filePath);
      results.push({
        projectDir: dirent.name,
        sessionId,
        filePath,
        lineCount: 0, // will count during read
        hasMessages: stat.size > 100,
      });
    }
  }

  return results.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

// ── Extract transcript from JSONL ───────────────────────────────────────────

async function extractTranscript(filePath: string): Promise<{
  transcript: string;
  messageCount: number;
  model?: string;
}> {
  const messages: string[] = [];
  let lineCount = 0;
  let model: string | undefined;

  const rl = createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const raw of rl) {
    lineCount++;
    try {
      const line: ClaudeLine = JSON.parse(raw);

      // Skip meta/commands/internal boilerplate
      if (line.isMeta) continue;
      if (line.type === "mode" || line.type === "system") continue;

      const msg = line.message;
      if (!msg || !msg.role || !msg.content) continue;

      // Skip user messages that are just <local-command-caveat> or <command-name>
      if (msg.role === "user") {
        const content = typeof msg.content === "string" ? msg.content : "";
        if (
          content.includes("<local-command-caveat>") ||
          content.includes("<command-name>") ||
          content.includes("<command-message>")
        ) {
          continue;
        }
      }

      // Extract text content (could be string or array of content blocks)
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .map((c: any) => (typeof c === "string" ? c : c.text || ""))
          .join(" ");
      }

      if (!text.trim()) continue;
      if (text.length < 20) continue; // skip too-short fragments

      // Extract model from assistant responses
      if (msg.role === "assistant" && !model) {
        model = (line as any).model || undefined;
      }

      messages.push(`[${msg.role.toUpperCase()}]\n${text}`);
    } catch {
      // skip malformed lines
    }
  }

  return {
    transcript: messages.join("\n\n---\n\n"),
    messageCount: messages.length,
    model,
  };
}

// ── Send to ingest API ──────────────────────────────────────────────────────

async function ingestSession(
  sessionId: string,
  project: string,
  transcript: string,
  provider: string,
): Promise<boolean> {
  try {
    const resp = await fetch(`${API_BASE}/api/dreams/ingest-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { "x-api-key": API_KEY } : {}),
      },
      body: JSON.stringify({
        content: transcript,
        session_id: sessionId,
        project: project,
        provider: provider,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => "unknown");
      console.error(`  [FAIL] HTTP ${resp.status}: ${err.slice(0, 200)}`);
      return false;
    }

    const data = await resp.json();
    console.log(
      `  [OK] ${data.dreamsExtracted ?? 0} dreams extracted`,
    );
    return true;
  } catch (err: any) {
    console.error(`  [FAIL] ${err.message}`);
    return false;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const projectFilter = args.find((a) => a.startsWith("--project="))?.split("=")[1];

  console.log("=".repeat(60));
  console.log("  🧠 Claude Code Session Dream Processor");
  console.log(`  ${force ? "FORCE reprocess all" : "Process new sessions only"}`);
  if (dryRun) console.log("  DRY RUN — no data sent to API");
  if (projectFilter) console.log(`  Filter project: ${projectFilter}`);
  console.log("=".repeat(60));

  // 1. Discover sessions
  const allSessions = discoverSessions();

  const filtered = projectFilter
    ? allSessions.filter((s) => s.projectDir.includes(projectFilter.replace(/[^a-z0-9_-]/gi, "")))
    : allSessions;

  console.log(`\nFound ${allSessions.length} sessions total, ${filtered.length} after filter\n`);

  if (filtered.length === 0) {
    console.log("No sessions to process.");
    return;
  }

  // 2. Read cache
  const cache = readCache();
  const processed = new Set(cache.processedSessions);

  const toProcess = force
    ? filtered
    : filtered.filter((s) => !processed.has(s.sessionId));

  console.log(`Already processed: ${processed.size}`);
  console.log(`To process now: ${toProcess.length}\n`);

  if (toProcess.length === 0) {
    console.log("All sessions already processed. Use --force to reprocess.");
    return;
  }

  // 3. Process each session
  let successCount = 0;
  let failCount = 0;

  for (const session of toProcess) {
    process.stdout.write(`📄 ${session.projectDir}/${session.sessionId.slice(0, 8)}... `);

    // Extract transcript
    const { transcript, messageCount, model } = await extractTranscript(session.filePath);

    if (messageCount < 2) {
      console.log(`\n  [SKIP] Only ${messageCount} messages — too short`);
      processed.add(session.sessionId);
      successCount++;
      continue;
    }

    console.log(`\n  Messages: ${messageCount}, model: ${model ?? "unknown"}, transcript: ~${transcript.length} chars`);

    if (dryRun) {
      console.log("  [DRY] Would send to ingest-session");
      processed.add(session.sessionId);
      successCount++;
      continue;
    }

    // Send to API
    const provider = model || "Claude";
    // Use the project dir name as the project hint
    const project = session.projectDir.replace(/^-/, "").replace(/-/g, "_");

    const ok = await ingestSession(
      session.sessionId,
      project,
      transcript,
      provider,
    );

    if (ok) {
      processed.add(session.sessionId);
      successCount++;
    } else {
      failCount++;
    }
  }

  // 4. Save cache
  cache.processedSessions = Array.from(processed).sort();
  writeCache(cache);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ✅ Done: ${successCount} succeeded, ${failCount} failed, ${toProcess.length - successCount - failCount} skipped`);
  console.log(`  Cache: ${cache.processedSessions.length} sessions tracked`);
  console.log(`${"=".repeat(60)}`);
}

main().catch((err) => {
  console.error("[ClaudeDreams] Fatal:", err);
  process.exit(1);
});
