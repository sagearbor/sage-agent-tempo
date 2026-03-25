import { describe, it, expect } from "vitest";
import { generateSummary } from "../../src/correlator/summary.js";
import type { BuildLog } from "../../src/parsers/types.js";

function makeBuildLog(): BuildLog {
  return {
    project: "test-project",
    agent: "claude-code",
    sessionId: "session-1",
    generatedAt: "2026-03-25T12:00:00.000Z",
    checklist: {
      source: "test-checklist.yaml",
      items: [
        {
          id: "item-1",
          title: "Setup project",
          phase: "phase-1",
          tags: ["config"],
          status: "done",
          startedAt: "2026-03-25T10:00:00.000Z",
          completedAt: "2026-03-25T10:30:00.000Z",
          durationMinutes: 30,
          tokens: {
            input: 5000,
            output: 2000,
            cacheRead: 500,
            cacheCreation: 100,
            total: 7600,
          },
          turns: 3,
          toolsUsed: ["Write", "Bash"],
          filesCreated: ["src/index.ts", "package.json"],
          filesModified: [],
          tests: { created: 0, passed: 0, failed: 0 },
          gitCommits: ["abc123"],
        },
        {
          id: "item-2",
          title: "Write parser",
          phase: "phase-2",
          tags: ["backend"],
          status: "done",
          startedAt: "2026-03-25T10:30:00.000Z",
          completedAt: "2026-03-25T11:15:00.000Z",
          durationMinutes: 45,
          tokens: {
            input: 8000,
            output: 4000,
            cacheRead: 1000,
            cacheCreation: 200,
            total: 13200,
          },
          turns: 5,
          toolsUsed: ["Write", "Read", "Bash"],
          filesCreated: ["src/parser.ts"],
          filesModified: ["src/index.ts"],
          tests: { created: 3, passed: 3, failed: 0 },
          gitCommits: ["def456"],
        },
        {
          id: "item-3",
          title: "Add tests",
          phase: "phase-2",
          tags: ["tests"],
          status: "in_progress",
          startedAt: "2026-03-25T11:15:00.000Z",
          completedAt: undefined,
          durationMinutes: 15,
          tokens: {
            input: 3000,
            output: 1500,
            cacheRead: 300,
            cacheCreation: 50,
            total: 4850,
          },
          turns: 2,
          toolsUsed: ["Write"],
          filesCreated: ["tests/parser.test.ts"],
          filesModified: [],
          tests: { created: 5, passed: 4, failed: 1 },
          gitCommits: [],
        },
      ],
    },
    timeline: [],
  };
}

describe("generateSummary", () => {
  it("calculates total duration from earliest start to latest end", () => {
    const log = makeBuildLog();
    const summary = generateSummary(log);

    // earliest: 10:00, latest completed: 11:15 = 75 minutes
    expect(summary.totalDurationMinutes).toBe(75);
  });

  it("sums total tokens across all items", () => {
    const log = makeBuildLog();
    const summary = generateSummary(log);

    // 7600 + 13200 + 4850 = 25650
    expect(summary.totalTokens).toBe(25650);
  });

  it("counts completed vs total items", () => {
    const log = makeBuildLog();
    const summary = generateSummary(log);

    expect(summary.itemsCompleted).toBe(2); // item-1 and item-2 are "done"
    expect(summary.itemsTotal).toBe(3);
  });

  it("sums test counts from checklist items when no testResults provided", () => {
    const log = makeBuildLog();
    const summary = generateSummary(log);

    // created: 0+3+5=8, passed: 0+3+4=7, failed: 0+0+1=1
    expect(summary.testsCreated).toBe(8);
    expect(summary.testsPassed).toBe(7);
    expect(summary.testsFailed).toBe(1);
  });

  it("uses testResults when provided", () => {
    const log = makeBuildLog();
    const testResults = {
      total: 20,
      passed: 18,
      failed: 2,
      skipped: 0,
      durationMs: 5000,
      suites: ["parser.test.ts"],
    };
    const summary = generateSummary(log, testResults);

    expect(summary.testsCreated).toBe(20);
    expect(summary.testsPassed).toBe(18);
    expect(summary.testsFailed).toBe(2);
  });

  it("counts unique files created across all items", () => {
    const log = makeBuildLog();
    const summary = generateSummary(log);

    // src/index.ts, package.json, src/parser.ts, tests/parser.test.ts = 4
    expect(summary.filesCreated).toBe(4);
  });

  it("deduplicates files created across items", () => {
    const log = makeBuildLog();
    // Add a duplicate file
    log.checklist.items[2].filesCreated.push("src/index.ts");
    const summary = generateSummary(log);

    // Still 4 unique files
    expect(summary.filesCreated).toBe(4);
  });

  it("builds architecture breakdown grouped by tag", () => {
    const log = makeBuildLog();
    const summary = generateSummary(log);

    expect(summary.architectureBreakdown["config"]).toEqual({
      tokens: 7600,
      files: 2,
      durationMinutes: 30,
    });

    expect(summary.architectureBreakdown["backend"]).toEqual({
      tokens: 13200,
      files: 1,
      durationMinutes: 45,
    });

    expect(summary.architectureBreakdown["tests"]).toEqual({
      tokens: 4850,
      files: 1,
      durationMinutes: 15,
    });
  });

  it("estimates cost using token pricing", () => {
    const log = makeBuildLog();
    const summary = generateSummary(log);

    // Manual calculation for item-1:
    // input: 5000/1M * 3.0 = 0.015
    // output: 2000/1M * 15.0 = 0.03
    // cacheRead: 500/1M * 0.3 = 0.00015
    // cacheCreation: 100/1M * 3.75 = 0.000375
    // item-1 cost = 0.045525

    expect(summary.totalEstimatedCostUsd).toBeGreaterThan(0);
    // Verify it's a reasonable number (should be small for these token counts)
    expect(summary.totalEstimatedCostUsd).toBeLessThan(1);
  });

  it("handles items with no timestamps gracefully", () => {
    const log = makeBuildLog();
    // Remove all timestamps
    for (const item of log.checklist.items) {
      item.startedAt = undefined;
      item.completedAt = undefined;
    }
    const summary = generateSummary(log);
    expect(summary.totalDurationMinutes).toBe(0);
  });
});
