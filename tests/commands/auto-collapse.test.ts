import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { autoCollapseIfNeeded } from "../../src/commands/collapse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, "../fixtures");

const sampleChecklist = {
  project: "test-project",
  phases: [
    {
      id: "phase-1",
      name: "Setup",
      items: [
        {
          id: "1.1",
          title: "Init repo",
          tags: ["config"],
          acceptance: "Repo exists",
          priority: "critical",
        },
        {
          id: "1.2",
          title: "Setup CI",
          tags: ["config"],
          acceptance: "CI runs",
        },
      ],
    },
    {
      id: "phase-2",
      name: "Implementation",
      items: [
        {
          id: "2.1",
          title: "Build parser",
          tags: ["backend"],
          acceptance: "Parser works",
        },
        {
          id: "2.2",
          title: "Build reporter",
          tags: ["backend"],
          acceptance: "Reporter works",
        },
      ],
    },
  ],
};

function makeBuildLog(items: { id: string; phase: string; status: string }[]) {
  return {
    project: "test-project",
    agent: "claude-code",
    sessionId: "test",
    generatedAt: "2026-03-25T00:00:00.000Z",
    checklist: {
      source: "developer_checklist.yaml",
      items: items.map((i) => ({
        ...i,
        title: "title",
        tags: [],
        turns: 0,
      })),
    },
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
}

describe("autoCollapseIfNeeded", () => {
  const checklistPath = join(fixturesDir, "auto-collapse-test-checklist.yaml");
  const buildLogPath = join(fixturesDir, "auto-collapse-test-build-log.json");

  beforeEach(() => {
    writeFileSync(checklistPath, stringifyYaml(sampleChecklist));
  });

  afterEach(() => {
    if (existsSync(checklistPath)) unlinkSync(checklistPath);
    if (existsSync(buildLogPath)) unlinkSync(buildLogPath);
  });

  it("collapses items in a 100% complete phase", () => {
    const buildLog = makeBuildLog([
      { id: "1.1", phase: "phase-1", status: "done" },
      { id: "1.2", phase: "phase-1", status: "done" },
      { id: "2.1", phase: "phase-2", status: "done" },
      { id: "2.2", phase: "phase-2", status: "in_progress" },
    ]);
    writeFileSync(buildLogPath, JSON.stringify(buildLog, null, 2));

    const result = autoCollapseIfNeeded(checklistPath, buildLogPath);

    expect(result.phasesCollapsed).toEqual(["phase-1"]);
    expect(result.totalCollapsed).toBe(2);

    // Verify phase-1 items lost their acceptance/priority
    const updated = parseYaml(readFileSync(checklistPath, "utf-8"));
    const phase1Item = updated.phases[0].items[0];
    expect(phase1Item.acceptance).toBeUndefined();
    expect(phase1Item.priority).toBeUndefined();
    expect(phase1Item.status).toBe("done");

    // phase-2 items should be untouched
    const phase2Item = updated.phases[1].items[0];
    expect(phase2Item.acceptance).toBe("Parser works");
  });

  it("does not collapse phases that are not 100% done", () => {
    const buildLog = makeBuildLog([
      { id: "1.1", phase: "phase-1", status: "done" },
      { id: "1.2", phase: "phase-1", status: "in_progress" },
      { id: "2.1", phase: "phase-2", status: "pending" },
      { id: "2.2", phase: "phase-2", status: "pending" },
    ]);
    writeFileSync(buildLogPath, JSON.stringify(buildLog, null, 2));

    const result = autoCollapseIfNeeded(checklistPath, buildLogPath);

    expect(result.phasesCollapsed).toEqual([]);
    expect(result.totalCollapsed).toBe(0);
  });

  it("collapses multiple phases when all are 100% done", () => {
    const buildLog = makeBuildLog([
      { id: "1.1", phase: "phase-1", status: "done" },
      { id: "1.2", phase: "phase-1", status: "done" },
      { id: "2.1", phase: "phase-2", status: "done" },
      { id: "2.2", phase: "phase-2", status: "done" },
    ]);
    writeFileSync(buildLogPath, JSON.stringify(buildLog, null, 2));

    const result = autoCollapseIfNeeded(checklistPath, buildLogPath);

    expect(result.phasesCollapsed).toContain("phase-1");
    expect(result.phasesCollapsed).toContain("phase-2");
    expect(result.totalCollapsed).toBe(4);
  });

  it("returns empty result when build log is missing", () => {
    const result = autoCollapseIfNeeded(
      checklistPath,
      join(fixturesDir, "nonexistent.json"),
    );
    expect(result.phasesCollapsed).toEqual([]);
    expect(result.totalCollapsed).toBe(0);
  });

  it("skips already-collapsed items", () => {
    // Pre-collapse an item
    const checklist = JSON.parse(JSON.stringify(sampleChecklist));
    checklist.phases[0].items[0] = {
      id: "1.1",
      title: "Init repo",
      status: "done",
      tags: ["config"],
    };
    writeFileSync(checklistPath, stringifyYaml(checklist));

    const buildLog = makeBuildLog([
      { id: "1.1", phase: "phase-1", status: "done" },
      { id: "1.2", phase: "phase-1", status: "done" },
      { id: "2.1", phase: "phase-2", status: "pending" },
      { id: "2.2", phase: "phase-2", status: "pending" },
    ]);
    writeFileSync(buildLogPath, JSON.stringify(buildLog, null, 2));

    const result = autoCollapseIfNeeded(checklistPath, buildLogPath);

    // Only 1.2 should be collapsed (1.1 was already collapsed)
    expect(result.phasesCollapsed).toEqual(["phase-1"]);
    expect(result.totalCollapsed).toBe(1);
  });
});
