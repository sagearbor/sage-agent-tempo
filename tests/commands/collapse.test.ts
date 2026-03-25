import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { collapseChecklist } from "../../src/commands/collapse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, "../fixtures");

const sampleChecklist = {
  project: "test-project",
  description: "A sample checklist for testing collapse",
  phases: [
    {
      id: "phase-1",
      name: "Setup",
      items: [
        {
          id: "setup-repo",
          title: "Initialize repository",
          tags: ["config"],
          priority: "critical",
          depends_on: [],
          acceptance: "Repository is initialized with correct structure",
          notes: "Use the standard template",
        },
        {
          id: "setup-ci",
          title: "Configure CI pipeline",
          tags: ["config", "tools"],
          priority: "high",
          depends_on: ["setup-repo"],
          acceptance: "CI pipeline runs on push",
        },
      ],
    },
    {
      id: "phase-2",
      name: "Implementation",
      items: [
        {
          id: "impl-parser",
          title: "Build the JSONL parser",
          tags: ["backend"],
          priority: "critical",
          depends_on: ["setup-repo"],
          acceptance: "Parser correctly reads JSONL files",
        },
      ],
    },
  ],
};

const sampleBuildLog = {
  project: "test-project",
  agent: "claude-code",
  sessionId: "test-session",
  generatedAt: "2026-03-25T00:00:00.000Z",
  checklist: {
    source: "developer_checklist.yaml",
    items: [
      {
        id: "setup-repo",
        title: "Initialize repository",
        phase: "phase-1",
        tags: ["config"],
        status: "done",
        turns: 5,
      },
      {
        id: "setup-ci",
        title: "Configure CI pipeline",
        phase: "phase-1",
        tags: ["config", "tools"],
        status: "in_progress",
        turns: 2,
      },
      {
        id: "impl-parser",
        title: "Build the JSONL parser",
        phase: "phase-2",
        tags: ["backend"],
        status: "done",
        turns: 10,
      },
    ],
  },
  summary: {
    totalDurationMinutes: 30,
    totalTokens: 5000,
    totalEstimatedCostUsd: 0.5,
    itemsCompleted: 2,
    itemsTotal: 3,
    testsCreated: 0,
    testsPassed: 0,
    testsFailed: 0,
    filesCreated: 0,
    architectureBreakdown: {},
  },
  timeline: [],
};

describe("collapseChecklist", () => {
  const checklistPath = join(fixturesDir, "collapse-test-checklist.yaml");
  const buildLogPath = join(fixturesDir, "collapse-test-build-log.json");

  beforeEach(() => {
    writeFileSync(checklistPath, stringifyYaml(sampleChecklist));
    writeFileSync(buildLogPath, JSON.stringify(sampleBuildLog, null, 2));
  });

  afterEach(() => {
    if (existsSync(checklistPath)) unlinkSync(checklistPath);
    if (existsSync(buildLogPath)) unlinkSync(buildLogPath);
  });

  it("reports correct counts", () => {
    const result = collapseChecklist(checklistPath, buildLogPath, false);
    expect(result.collapsed).toBe(2);
    expect(result.total).toBe(3);
    expect(result.remaining).toBe(1);
    expect(result.collapsedIds).toEqual(["setup-repo", "impl-parser"]);
  });

  it("removes acceptance, notes, priority, depends_on from done items", () => {
    collapseChecklist(checklistPath, buildLogPath, false);
    const output = parseYaml(readFileSync(checklistPath, "utf-8"));

    const setupRepo = output.phases[0].items[0];
    expect(setupRepo.id).toBe("setup-repo");
    expect(setupRepo.title).toBe("Initialize repository");
    expect(setupRepo.status).toBe("done");
    expect(setupRepo.tags).toEqual(["config"]);
    expect(setupRepo.acceptance).toBeUndefined();
    expect(setupRepo.notes).toBeUndefined();
    expect(setupRepo.priority).toBeUndefined();
    expect(setupRepo.depends_on).toBeUndefined();
  });

  it("leaves non-done items untouched", () => {
    collapseChecklist(checklistPath, buildLogPath, false);
    const output = parseYaml(readFileSync(checklistPath, "utf-8"));

    const setupCi = output.phases[0].items[1];
    expect(setupCi.id).toBe("setup-ci");
    expect(setupCi.acceptance).toBe("CI pipeline runs on push");
    expect(setupCi.priority).toBe("high");
    expect(setupCi.depends_on).toEqual(["setup-repo"]);
  });

  it("preserves tags on collapsed items", () => {
    collapseChecklist(checklistPath, buildLogPath, false);
    const output = parseYaml(readFileSync(checklistPath, "utf-8"));

    const implParser = output.phases[1].items[0];
    expect(implParser.tags).toEqual(["backend"]);
  });

  it("dry-run does not modify the file", () => {
    const originalContent = readFileSync(checklistPath, "utf-8");
    const result = collapseChecklist(checklistPath, buildLogPath, true);

    expect(result.collapsed).toBe(2);
    const afterContent = readFileSync(checklistPath, "utf-8");
    expect(afterContent).toBe(originalContent);
  });

  it("handles missing build_log.json gracefully (no items collapsed)", () => {
    const missingLogPath = join(fixturesDir, "nonexistent-build-log.json");
    const result = collapseChecklist(checklistPath, missingLogPath, false);

    expect(result.collapsed).toBe(0);
    expect(result.total).toBe(3);
    expect(result.remaining).toBe(3);
  });

  it("handles checklist with no phases", () => {
    const emptyChecklist = { project: "empty", phases: [] };
    writeFileSync(checklistPath, stringifyYaml(emptyChecklist));

    const result = collapseChecklist(checklistPath, buildLogPath, false);
    expect(result.collapsed).toBe(0);
    expect(result.total).toBe(0);
  });
});
