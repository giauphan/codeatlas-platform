#!/usr/bin/env node
/**
 * Bidirectional Skill to Genome Sync
 *
 * Modes:
 *   upload   - Local skills to Cloud Genome (default)
 *   download - Cloud Genome to Local skills
 *   bidir    - Both directions
 *
 * Usage:
 *   npx tsx scripts/sync-genome-bidir.ts <api-key> [api-base] [mode]
 *   Configure CODEATLAS_API_URL to trust a custom API origin; api-base must match it.
 *   Set CODEATLAS_ALLOW_PRIVATE_API_URL=1 for a trusted private API endpoint.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

const keyArg = process.argv[2] || process.env.CODEATLAS_API_KEY || "";
const API_BASE = process.argv[3] || process.env.CODEATLAS_API_URL || "https://atlas.genrostore.com";
const MODE = (process.argv[4] || "upload");
const DEMO = !keyArg || keyArg === "demo";

function safeLogValue(value: unknown): string {
  return String(value).replace(/[\r\n\u2028\u2029]/g, " ").slice(0, 500);
}

export function getApiBase(
  value: string,
  allowPrivate = process.env.CODEATLAS_ALLOW_PRIVATE_API_URL === "1",
  trustedApiBase = process.env.CODEATLAS_API_URL || "https://atlas.genrostore.com",
): URL {
  let url;
  let trustedUrl;
  try {
    url = new URL(value);
    trustedUrl = new URL(trustedApiBase);
  } catch {
    throw new Error("API base and configured trusted API URL must be valid absolute URLs");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const ipLiteral = hostname.replace(/^\[|\]$/g, "");
  const isLoopback = hostname === "localhost" || hostname.endsWith(".localhost") ||
    (isIP(ipLiteral) === 4 && ipLiteral.startsWith("127.")) || ipLiteral === "::1";
  const isInternalHostname = (!hostname.includes(".") && hostname !== "localhost") ||
    /(?:^|\.)(?:local|localdomain|internal|localhost|test|invalid)$/.test(hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && (isLoopback || allowPrivate))) ||
      (!allowPrivate && (isIP(ipLiteral) !== 0 && !isLoopback || isInternalHostname)) ||
      url.username || url.password || url.search || url.hash || url.origin !== trustedUrl.origin) {
    throw new Error("API base must match the configured trusted API origin and use HTTPS; private hosts require CODEATLAS_ALLOW_PRIVATE_API_URL=1 (HTTP is allowed only for loopback or with that opt-in), and credentials, query, and fragment are not allowed");
  }

  return url;
}

const SKILLS_DIR = path.join(process.env.HOME || "/home/ubuntu", ".hermes", "skills");

const CORE_SKILLS = [
  ["code-review-and-quality", "Multi-axis code review: correctness, readability, architecture, security, performance", "workflow"],
  ["debugging-and-error-recovery", "Systematic root-cause debugging with hypothesis-driven approach", "workflow"],
  ["performance-optimization", "Profile-driven performance optimization", "pattern"],
  ["security-and-hardening", "Code hardening: input validation, auth, injection prevention", "pattern"],
  ["tdd", "Test-driven development with red-green-refactor loop", "workflow"],
  ["ai-second-brain", "CRISPR-inspired Genome: genes, evolution, immune system, MCP", "architecture"],
  ["ci-cd-and-automation", "CI/CD pipeline setup: quality gates, test runners, deployment", "infra"],
  ["planning-and-task-breakdown", "Break specs into ordered tasks with dependency tracking", "workflow"],
  ["code-simplification", "Simplify code for clarity without changing behavior", "pattern"],
  ["documentation-and-adrs", "Record architectural decisions and documentation", "workflow"],
];

export function createApiCall(apiBase: URL, apiKey: string, fetcher: typeof fetch = fetch) {
  return async function apiCall(pathStr: string, opts: RequestInit = {}): Promise<Response> {
    let end = apiBase.pathname.length;
    while (end > 0 && apiBase.pathname[end - 1] === "/") end--;
    const basePath = apiBase.pathname.slice(0, end);
    const endpointPath = pathStr.replace(/^\/+/, "");
    const url = new URL(`${basePath}/${endpointPath}`, apiBase.origin);
    const headers = new Headers(opts.headers);
    if (apiKey) headers.set("x-api-key", apiKey);
    if (opts.method && opts.method !== "GET") headers.set("Content-Type", "application/json");
    return fetcher(url, { ...opts, headers, redirect: "error" });
  };
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
}

// ── Upload ──────────────────────────────────────────────
function getLocalSkills() {
  const localSkills = [];
  if (fs.existsSync(SKILLS_DIR)) {
    for (const dir of fs.readdirSync(SKILLS_DIR)) {
      const skillPath = path.join(SKILLS_DIR, dir, "SKILL.md");
      if (fs.existsSync(skillPath)) {
        const content = fs.readFileSync(skillPath, "utf-8");
        const desc = content.match(/^description: "(.+)"$/m)?.[1] || "";
        const cat = content.match(/^category: (.+)$/m)?.[1] || "workflow";
        localSkills.push([dir, desc, cat]);
      }
    }
  }
  return localSkills;
}

async function uploadSkill(apiCall, [name, desc, cat]) {
  process.stdout.write("  " + name + "... ");

  if (DEMO) {
    console.log("(would sync " + cat + ")");
    return true;
  }

  try {
    const res = await apiCall("/api/genome/gene", {
      method: "POST",
      body: JSON.stringify({
        name, description: desc, problem: "Need " + name,
        solution: desc, category: cat, project: "codeatlas-genome",
        sourceType: "skill", confidence: 0.70,
      }),
    });
    const data = await res.json();
    if (data.success) {
      console.log("OK");
      return true;
    }
    console.log("FAIL: " + safeLogValue(data.error || res.status));
  } catch (e) {
    console.log("FAIL: " + safeLogValue(e instanceof Error ? e.message : e));
  }
  return false;
}

async function upload(apiCall) {
  console.log("\nUpload: Local skills to Cloud Genome");
  const localSkills = getLocalSkills();
  const toUpload = localSkills.length > 0 ? localSkills : CORE_SKILLS;
  let count = 0;
  for (const skill of toUpload) {
    // Serialize upserts to preserve output order and avoid racing gene version updates.
    if (await uploadSkill(apiCall, skill)) count++; // NOSONAR
  }
  return count;
}

// ── Download ────────────────────────────────────────────
async function download(apiCall) {
  console.log("\nDownload: Cloud Genome to Local skills");
  if (DEMO) { console.log("  (demo — would download)\n"); return 0; }

  const res = await apiCall("/api/genome/search?query=skill+gene&limit=50&project=codeatlas-genome");
  if (!res.ok) { console.log("  API error: " + res.status); return 0; }
  const data = await res.json();
  const genes = data.genes || [];
  if (!Array.isArray(genes)) throw new Error('Invalid genome response: genes must be an array');
  console.log("  Found " + Number(genes.length) + " skill genes");
  let count = 0;

  for (const gene of genes) {
    const name = slugify(gene.name);
    const dirPath = path.join(SKILLS_DIR, name);
    const filePath = path.join(dirPath, "SKILL.md");

    if (fs.existsSync(filePath)) { console.log("  Skip " + name + " (exists)"); continue; }

    fs.mkdirSync(dirPath, { recursive: true });
    const md = [
      "---",
      "name: " + name,
      'description: "' + (gene.description || "") + '"',
      "category: " + (gene.category || "workflow"),
      "version: " + (gene.version || 1) + ".0.0",
      "source: genome-sync",
      "---",
      "",
      "# " + gene.name,
      "",
      "## Problem",
      gene.problem || "",
      "",
      "## Solution",
      gene.solution || gene.description || "",
      "",
      "---",
      "Confidence: " + ((gene.confidence || 0.5) * 100).toFixed(0) + "%",
      "Version: " + (gene.version || 1),
      "",
    ].join("\n");

    fs.writeFileSync(filePath, md, "utf-8");
    console.log("  Created: " + name + " -> " + filePath);
    count++;
  }

  const total = fs.readdirSync(SKILLS_DIR).filter(d =>
    fs.existsSync(path.join(SKILLS_DIR, d, "SKILL.md"))
  ).length;
  console.log("\n  Local skills now: " + total);
  return count;
}

// ── Main ────────────────────────────────────────────────
async function main() {
  const apiCall = createApiCall(getApiBase(API_BASE), DEMO ? "" : keyArg);
  console.log("Bidirectional Skill <-> Genome Sync");
  console.log("Mode: " + MODE + (DEMO ? " (DEMO)" : ""));
  console.log("API: " + safeLogValue(API_BASE) + "\n");

  let up = 0, down = 0;
  if (MODE === "upload" || MODE === "bidir") up = await upload(apiCall);
  if (MODE === "download" || MODE === "bidir") down = await download(apiCall);

  console.log("\n---");
  console.log("Uploaded: " + up + " | Downloaded: " + down);

  if (DEMO) {
    console.log("\nReal run:");
    console.log("  npx tsx scripts/sync-genome-bidir.ts <api-key> " + API_BASE + " bidir");
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error: unknown) {
    console.error(error);
    process.exitCode = 1;
  }
}
