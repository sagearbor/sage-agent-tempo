#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseChecklist } from "./collectors/checklist.js";
import { parseAuto } from "./parsers/index.js";
import { correlate } from "./correlator/index.js";
import { getCommitsSince } from "./collectors/git.js";
import { writeDashboard } from "./reporters/html-dashboard.js";
import { writeExecutiveSummary } from "./reporters/executive-summary.js";
import { writeExcalidrawFiles } from "./reporters/excalidraw.js";
import type { BuildLog } from "./parsers/types.js";

const program = new Command();

program
  .name("sage-agent-tempo")
  .description(
    "Track what AI agents build, how long it takes, and what it costs"
  )
  .version("0.1.0");

// ── parse ──────────────────────────────────────────────────────────

program
  .command("parse")
  .description("Run parser + correlator, write build_log.json")
  .option("--agent <agent>", "Agent type (claude-code, codex)")
  .option(
    "--checklist <path>",
    "Path to developer_checklist.yaml",
    "developer_checklist.yaml"
  )
  .option("--output <path>", "Output path for build_log.json", "build_log.json")
  .option("--session-dir <path>", "Override session directory")
  .action(async (opts) => {
    try {
      const checklistPath = resolve(opts.checklist);
      if (!existsSync(checklistPath)) {
        console.error(`Checklist not found: ${checklistPath}`);
        process.exit(1);
      }

      console.log("Parsing checklist...");
      const checklist = parseChecklist(checklistPath);

      console.log("Parsing session files...");
      const sessions = await parseAuto({
        agent: opts.agent,
        sessionDir: opts.sessionDir,
      });
      console.log(`Found ${sessions.length} session(s)`);

      console.log("Collecting git history...");
      const commits = getCommitsSince(
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      );

      console.log("Correlating data...");
      const buildLog = correlate({ sessions, checklist, commits });

      const outputPath = resolve(opts.output);
      writeFileSync(outputPath, JSON.stringify(buildLog, null, 2));
      console.log(`Build log written to ${outputPath}`);
    } catch (err) {
      console.error("Parse failed:", (err as Error).message);
      process.exit(1);
    }
  });

// ── report ─────────────────────────────────────────────────────────

program
  .command("report")
  .description("Generate reports from build_log.json")
  .option(
    "--format <format>",
    "Report format (all, dashboard, executive, excalidraw)",
    "all"
  )
  .option("--output-dir <dir>", "Output directory for reports", "reports")
  .option("--input <path>", "Path to build_log.json", "build_log.json")
  .action(async (opts) => {
    try {
      const inputPath = resolve(opts.input);
      if (!existsSync(inputPath)) {
        console.error(`Build log not found: ${inputPath}`);
        console.error("Run 'sage-agent-tempo parse' first.");
        process.exit(1);
      }

      const buildLog: BuildLog = JSON.parse(readFileSync(inputPath, "utf-8"));
      const outputDir = resolve(opts.outputDir);
      mkdirSync(outputDir, { recursive: true });

      const format = opts.format;

      if (format === "all" || format === "dashboard") {
        const dashPath = join(outputDir, "dashboard.html");
        writeDashboard(buildLog, dashPath);
        console.log(`Dashboard written to ${dashPath}`);
      }

      if (format === "all" || format === "executive") {
        const execPath = join(outputDir, "executive-summary.html");
        writeExecutiveSummary(buildLog, execPath);
        console.log(`Executive summary written to ${execPath}`);
      }

      if (format === "all" || format === "excalidraw") {
        await writeExcalidrawFiles(buildLog, outputDir);
        console.log(`Excalidraw diagrams written to ${outputDir}`);
      }

      console.log("Reports generated successfully.");
    } catch (err) {
      console.error("Report generation failed:", (err as Error).message);
      process.exit(1);
    }
  });

// ── backfill ───────────────────────────────────────────────────────

program
  .command("backfill")
  .description("Best-effort log from old session files")
  .option("--since <date>", "Start date (ISO format)", "2026-01-01")
  .option("--until <date>", "End date (ISO format)")
  .option("--agent <agent>", "Agent type (claude-code, codex)")
  .option("--output <path>", "Output path", "build_log.json")
  .action(async (opts) => {
    try {
      console.log(`Backfilling sessions since ${opts.since}...`);
      const sessions = await parseAuto({ agent: opts.agent });

      const since = new Date(opts.since).getTime();
      const until = opts.until ? new Date(opts.until).getTime() : Date.now();

      const filtered = sessions.filter((s) => {
        const t = new Date(s.startedAt).getTime();
        return t >= since && t <= until;
      });

      console.log(`Found ${filtered.length} session(s) in range`);

      const buildLog: BuildLog = {
        project: "backfill",
        agent: filtered[0]?.agent ?? "unknown",
        sessionId: filtered.map((s) => s.sessionId).join(","),
        generatedAt: new Date().toISOString(),
        checklist: { source: "none", items: [] },
        summary: {
          totalDurationMinutes: 0,
          totalTokens: 0,
          totalEstimatedCostUsd: 0,
          itemsCompleted: 0,
          itemsTotal: 0,
          testsCreated: 0,
          testsPassed: 0,
          testsFailed: 0,
          filesCreated: 0,
          architectureBreakdown: {},
        },
        timeline: [],
      };

      const outputPath = resolve(opts.output);
      writeFileSync(outputPath, JSON.stringify(buildLog, null, 2));
      console.log(`Backfill log written to ${outputPath}`);
    } catch (err) {
      console.error("Backfill failed:", (err as Error).message);
      process.exit(1);
    }
  });

// ── validate ───────────────────────────────────────────────────────

program
  .command("validate")
  .description("Validate a developer_checklist.yaml")
  .argument("[path]", "Path to checklist", "developer_checklist.yaml")
  .action((checklistPath: string) => {
    try {
      const fullPath = resolve(checklistPath);
      if (!existsSync(fullPath)) {
        console.error(`File not found: ${fullPath}`);
        process.exit(1);
      }

      const result = parseChecklist(fullPath);
      console.log(`✓ Valid checklist: "${result.project}"`);
      console.log(`  ${result.items.length} items across phases`);

      const phases = [...new Set(result.items.map((i) => i.phaseName))];
      for (const phase of phases) {
        const count = result.items.filter((i) => i.phaseName === phase).length;
        console.log(`  - ${phase}: ${count} items`);
      }
    } catch (err) {
      console.error(`✗ Invalid checklist: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ── init ───────────────────────────────────────────────────────────

program
  .command("init")
  .description("Scaffold a developer_checklist.yaml template")
  .option("--project <name>", "Project name", "my-project")
  .action((opts) => {
    const outputPath = resolve("developer_checklist.yaml");
    if (existsSync(outputPath)) {
      console.error("developer_checklist.yaml already exists. Aborting.");
      process.exit(1);
    }

    const template = `project: ${opts.project}
description: >
  Brief description of what this project does.

phases:
  - id: setup
    name: Project Setup
    items:
      - id: "1.1"
        title: Initialize project scaffolding
        tags: [config]
        acceptance: package.json exists, project compiles

  - id: core
    name: Core Features
    items:
      - id: "2.1"
        title: Build main feature
        tags: [backend]
        depends_on: ["1.1"]
        acceptance: Feature works end-to-end
`;

    writeFileSync(outputPath, template);
    console.log(`Created ${outputPath}`);
    console.log("Edit it with your project's phases and checklist items.");
  });

program.parse();
