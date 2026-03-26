import { describe, it, expect } from "vitest";
import { generateComparisonDashboard } from "../../src/reporters/comparison-dashboard.js";
import type { BuildLog } from "../../src/parsers/types.js";

function makeBuildLog(overrides: Partial<BuildLog> = {}): BuildLog {
  return {
    project: "project-a",
    agent: "claude-code",
    sessionId: "session-1",
    generatedAt: "2026-03-25T12:00:00.000Z",
    checklist: {
      source: "test-checklist.yaml",
      items: [
        {
          id: "item-1",
          title: "Setup project",
          phase: "setup",
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
          title: "Build core feature",
          phase: "core",
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
          toolsUsed: ["Write", "Read"],
          filesCreated: ["src/core.ts"],
          filesModified: ["src/index.ts"],
          tests: { created: 3, passed: 3, failed: 0 },
          gitCommits: ["def456"],
        },
      ],
    },
    summary: {
      totalDurationMinutes: 75,
      totalTokens: 20800,
      totalEstimatedCostUsd: 0.15,
      itemsCompleted: 2,
      itemsTotal: 2,
      testsCreated: 3,
      testsPassed: 3,
      testsFailed: 0,
      filesCreated: 3,
      architectureBreakdown: {
        config: { tokens: 7600, files: 2, durationMinutes: 30 },
        backend: { tokens: 13200, files: 1, durationMinutes: 45 },
      },
    },
    timeline: [
      {
        type: "tool_call",
        at: "2026-03-25T10:05:00.000Z",
        tokens: 3000,
      },
      {
        type: "tool_call",
        at: "2026-03-25T10:20:00.000Z",
        tokens: 4600,
      },
      {
        type: "tool_call",
        at: "2026-03-25T10:45:00.000Z",
        tokens: 8000,
      },
    ],
    ...overrides,
  };
}

function makeSecondBuildLog(): BuildLog {
  return makeBuildLog({
    project: "project-b",
    sessionId: "session-2",
    summary: {
      totalDurationMinutes: 120,
      totalTokens: 45000,
      totalEstimatedCostUsd: 0.35,
      itemsCompleted: 3,
      itemsTotal: 4,
      testsCreated: 10,
      testsPassed: 9,
      testsFailed: 1,
      filesCreated: 8,
      architectureBreakdown: {
        backend: { tokens: 20000, files: 4, durationMinutes: 60 },
        frontend: { tokens: 15000, files: 3, durationMinutes: 40 },
        tests: { tokens: 10000, files: 2, durationMinutes: 20 },
      },
    },
    checklist: {
      source: "test-checklist-b.yaml",
      items: [
        {
          id: "b-1",
          title: "API endpoints",
          phase: "core",
          tags: ["backend"],
          status: "done",
          startedAt: "2026-03-25T09:00:00.000Z",
          completedAt: "2026-03-25T10:00:00.000Z",
          durationMinutes: 60,
          tokens: {
            input: 10000,
            output: 5000,
            cacheRead: 2000,
            cacheCreation: 500,
            total: 17500,
          },
          turns: 8,
          toolsUsed: ["Write"],
          filesCreated: ["src/api.ts"],
          filesModified: [],
          tests: { created: 5, passed: 5, failed: 0 },
          gitCommits: ["ghi789"],
        },
        {
          id: "b-2",
          title: "Frontend UI",
          phase: "frontend",
          tags: ["frontend"],
          status: "done",
          startedAt: "2026-03-25T10:00:00.000Z",
          completedAt: "2026-03-25T10:40:00.000Z",
          durationMinutes: 40,
          tokens: {
            input: 8000,
            output: 4000,
            cacheRead: 1500,
            cacheCreation: 300,
            total: 13800,
          },
          turns: 6,
          toolsUsed: ["Write", "Read"],
          filesCreated: ["src/ui.tsx"],
          filesModified: [],
          tests: { created: 3, passed: 2, failed: 1 },
          gitCommits: ["jkl012"],
        },
      ],
    },
    timeline: [
      {
        type: "tool_call",
        at: "2026-03-25T09:10:00.000Z",
        tokens: 5000,
      },
      {
        type: "tool_call",
        at: "2026-03-25T09:30:00.000Z",
        tokens: 12500,
      },
      {
        type: "tool_call",
        at: "2026-03-25T10:20:00.000Z",
        tokens: 10000,
      },
    ],
  });
}

describe("generateComparisonDashboard", () => {
  it("returns a valid HTML document", () => {
    const html = generateComparisonDashboard([makeBuildLog(), makeSecondBuildLog()]);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("includes the page title", () => {
    const html = generateComparisonDashboard([makeBuildLog(), makeSecondBuildLog()]);
    expect(html).toContain("Cross-Project Comparison");
  });

  it("includes project names in the summary table", () => {
    const html = generateComparisonDashboard([makeBuildLog(), makeSecondBuildLog()]);
    expect(html).toContain("project-a");
    expect(html).toContain("project-b");
  });

  it("includes summary metrics in the table", () => {
    const html = generateComparisonDashboard([makeBuildLog(), makeSecondBuildLog()]);
    // project-a: 20,800 tokens
    expect(html).toContain("20,800");
    // project-b: 45,000 tokens
    expect(html).toContain("45,000");
    // project-a cost: $0.15
    expect(html).toContain("$0.15");
    // project-b cost: $0.35
    expect(html).toContain("$0.35");
  });

  it("includes items completed ratios", () => {
    const html = generateComparisonDashboard([makeBuildLog(), makeSecondBuildLog()]);
    expect(html).toContain("2/2");
    expect(html).toContain("3/4");
  });

  it("includes files created counts", () => {
    const logA = makeBuildLog();
    const logB = makeSecondBuildLog();
    const html = generateComparisonDashboard([logA, logB]);
    // project-a: 3 files, project-b: 8 files
    expect(html).toMatch(/<td>3<\/td>/);
    expect(html).toMatch(/<td>8<\/td>/);
  });

  it("includes Plotly script tag", () => {
    const html = generateComparisonDashboard([makeBuildLog(), makeSecondBuildLog()]);
    expect(html).toContain("plotly-2.35.0.min.js");
  });

  it("renders token burn chart section", () => {
    const html = generateComparisonDashboard([makeBuildLog(), makeSecondBuildLog()]);
    expect(html).toContain('id="tokenBurn"');
    expect(html).toContain("Cumulative Token Burn");
  });

  it("renders cost by phase chart section", () => {
    const html = generateComparisonDashboard([makeBuildLog(), makeSecondBuildLog()]);
    expect(html).toContain('id="costByPhase"');
    expect(html).toContain("Cost by Phase");
  });

  it("renders architecture comparison chart section", () => {
    const html = generateComparisonDashboard([makeBuildLog(), makeSecondBuildLog()]);
    expect(html).toContain('id="archComparison"');
    expect(html).toContain("Architecture Token Distribution");
  });

  it("handles projects with no timeline data gracefully", () => {
    const logA = makeBuildLog({ timeline: [] });
    const logB = makeSecondBuildLog();
    // Should not throw
    const html = generateComparisonDashboard([logA, logB]);
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("handles projects with empty architecture breakdown", () => {
    const logA = makeBuildLog();
    logA.summary.architectureBreakdown = {};
    const logB = makeSecondBuildLog();
    const html = generateComparisonDashboard([logA, logB]);
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("handles projects with no checklist items", () => {
    const logA = makeBuildLog();
    logA.checklist.items = [];
    const logB = makeSecondBuildLog();
    const html = generateComparisonDashboard([logA, logB]);
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("escapes HTML in project names", () => {
    const logA = makeBuildLog({ project: '<script>alert("xss")</script>' });
    const logB = makeSecondBuildLog();
    const html = generateComparisonDashboard([logA, logB]);
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  it("includes project count in subtitle", () => {
    const html = generateComparisonDashboard([makeBuildLog(), makeSecondBuildLog()]);
    expect(html).toContain("2 project(s) compared");
  });
});
