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
 */

import * as fs from "node:fs";
import * as path from "node:path";

const keyArg = process.argv[2] || process.env.CODEATLAS_API_KEY || "";
const API_BASE = process.argv[3] || process.env.CODEATLAS_API_URL || "https://atlas.genrostore.com";
const MODE = (process.argv[4] || "upload");
const DEMO = !keyArg || keyArg === "demo";

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

async function apiCall(pathStr, opts = {}) {
  const url = API_BASE + pathStr;
  const headers = {};
  if (!DEMO) headers["x-api-key"] = keyArg;
  if (opts.method && opts.method !== "GET") headers["Content-Type"] = "application/json";
  return fetch(url, { ...opts, headers });
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
}

// ── Upload ──────────────────────────────────────────────
async function upload() {
  console.log("\nUpload: Local skills to Cloud Genome");

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

  const toUpload = localSkills.length > 0 ? localSkills : CORE_SKILLS;
  let count = 0;

  for (const [name, desc, cat] of toUpload) {
    process.stdout.write("  " + name + "... ");

    if (DEMO) { console.log("(would sync " + cat + ")"); count++; continue; }

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
      if (data.success) { console.log("OK"); count++; }
      else { console.log("FAIL: " + (data.error || res.status)); }
    } catch (e) { console.log("FAIL: " + e.message); }
  }
  return count;
}

// ── Download ────────────────────────────────────────────
async function download() {
  console.log("\nDownload: Cloud Genome to Local skills");
  if (DEMO) { console.log("  (demo — would download)\n"); return 0; }

  const res = await apiCall("/api/genome/search?query=skill+gene&limit=50&project=codeatlas-genome");
  if (!res.ok) { console.log("  API error: " + res.status); return 0; }
  const data = await res.json();
  const genes = data.genes || [];
  console.log("  Found " + genes.length + " skill genes");
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
  console.log("Bidirectional Skill <-> Genome Sync");
  console.log("Mode: " + MODE + (DEMO ? " (DEMO)" : ""));
  console.log("API: " + API_BASE + "\n");

  let up = 0, down = 0;
  if (MODE === "upload" || MODE === "bidir") up = await upload();
  if (MODE === "download" || MODE === "bidir") down = await download();

  console.log("\n---");
  console.log("Uploaded: " + up + " | Downloaded: " + down);

  if (DEMO) {
    console.log("\nReal run:");
    console.log("  npx tsx scripts/sync-genome-bidir.ts <api-key> " + API_BASE + " bidir");
  }
}

main().catch(console.error);
