import { describe, it, expect } from "vitest";
import { inferWorkBlocks } from "../../src/correlator/auto-infer.js";
import type { SessionSummary, GitCommit, NormalizedTurn } from "../../src/parsers/types.js";

function makeTurn(overrides: Partial<NormalizedTurn> & { timestamp: string }): NormalizedTurn {
  return {
    sessionId: "sess-1",
    uuid: undefined,
    parentUuid: undefined,
    model: "claude-3",
    tokens: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, total: 150 },
    toolCalls: [],
    filesTouched: [],
    content: "",
    isSubagent: false,
    ...overrides,
  };
}

function makeSession(turns: NormalizedTurn[]): SessionSummary {
  return {
    sessionId: turns[0]?.sessionId ?? "sess-1",
    agent: "claude-code",
    startedAt: turns[0]?.timestamp ?? "2026-03-20T10:00:00.000Z",
    endedAt: turns[turns.length - 1]?.timestamp ?? "2026-03-20T11:00:00.000Z",
    durationMinutes: 60,
    turns,
    totalTokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
    model: "claude-3",
  };
}

describe("inferWorkBlocks", () => {
  it("returns empty checklist for empty sessions", () => {
    const result = inferWorkBlocks([]);
    expect(result.items).toHaveLength(0);
    expect(result.project).toBe("auto-inferred");
  });

  it("groups turns into a single block when no time gaps", () => {
    const turns = [
      makeTurn({ timestamp: "2026-03-20T10:00:00.000Z", filesTouched: ["src/index.ts"] }),
      makeTurn({ timestamp: "2026-03-20T10:01:00.000Z", filesTouched: ["src/index.ts"] }),
      makeTurn({ timestamp: "2026-03-20T10:02:00.000Z", filesTouched: ["src/utils.ts"] }),
    ];
    const result = inferWorkBlocks([makeSession(turns)]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toContain("src/");
  });

  it("splits into multiple blocks on time gaps > 5 min", () => {
    const turns = [
      makeTurn({ timestamp: "2026-03-20T10:00:00.000Z", filesTouched: ["src/a.ts"] }),
      makeTurn({ timestamp: "2026-03-20T10:01:00.000Z", filesTouched: ["src/a.ts"] }),
      // 10 minute gap
      makeTurn({ timestamp: "2026-03-20T10:11:00.000Z", filesTouched: ["tests/b.test.ts"] }),
      makeTurn({ timestamp: "2026-03-20T10:12:00.000Z", filesTouched: ["tests/b.test.ts"] }),
    ];
    const result = inferWorkBlocks([makeSession(turns)]);
    expect(result.items.length).toBe(2);
  });

  it("splits blocks at git commit boundaries", () => {
    const turns = [
      makeTurn({ timestamp: "2026-03-20T10:00:00.000Z", filesTouched: ["src/a.ts"] }),
      makeTurn({ timestamp: "2026-03-20T10:01:00.000Z", filesTouched: ["src/a.ts"] }),
      makeTurn({ timestamp: "2026-03-20T10:02:00.000Z", filesTouched: ["src/b.ts"] }),
      makeTurn({ timestamp: "2026-03-20T10:03:00.000Z", filesTouched: ["src/b.ts"] }),
    ];

    const commits: GitCommit[] = [
      {
        sha: "abc123",
        message: "feat: add a.ts",
        timestamp: "2026-03-20T10:01:30.000Z",
        author: "dev",
        filesChanged: [],
      },
    ];

    const result = inferWorkBlocks([makeSession(turns)], commits);
    expect(result.items.length).toBe(2);
  });

  it("labels blocks from agent work announcements", () => {
    const turns = [
      makeTurn({
        timestamp: "2026-03-20T10:00:00.000Z",
        content: "Let me build the authentication module for the API.",
        filesTouched: ["src/auth.ts"],
      }),
      makeTurn({ timestamp: "2026-03-20T10:01:00.000Z", filesTouched: ["src/auth.ts"] }),
    ];
    const result = inferWorkBlocks([makeSession(turns)]);
    expect(result.items[0].title).toContain("the authentication module for the API");
  });

  it("labels blocks by directory when no announcements", () => {
    const turns = [
      makeTurn({ timestamp: "2026-03-20T10:00:00.000Z", filesTouched: ["src/parsers/a.ts"] }),
      makeTurn({ timestamp: "2026-03-20T10:01:00.000Z", filesTouched: ["src/parsers/b.ts"] }),
    ];
    const result = inferWorkBlocks([makeSession(turns)]);
    expect(result.items[0].title).toContain("src/parsers/");
  });

  it("infers tags from file paths", () => {
    const turns = [
      makeTurn({ timestamp: "2026-03-20T10:00:00.000Z", filesTouched: ["tests/foo.test.ts"] }),
      makeTurn({ timestamp: "2026-03-20T10:01:00.000Z", filesTouched: ["tests/bar.test.ts"] }),
    ];
    const result = inferWorkBlocks([makeSession(turns)]);
    expect(result.items[0].tags).toContain("tests");
  });

  it("handles blocks with no files touched by using tool names", () => {
    const turns = [
      makeTurn({
        timestamp: "2026-03-20T10:00:00.000Z",
        toolCalls: [{ toolName: "Bash" }],
      }),
      makeTurn({
        timestamp: "2026-03-20T10:01:00.000Z",
        toolCalls: [{ toolName: "Bash" }],
      }),
    ];
    const result = inferWorkBlocks([makeSession(turns)]);
    expect(result.items[0].title).toContain("Bash");
  });

  it("includes description noting auto-inference", () => {
    const turns = [
      makeTurn({ timestamp: "2026-03-20T10:00:00.000Z", filesTouched: ["src/a.ts"] }),
    ];
    const result = inferWorkBlocks([makeSession(turns)]);
    expect(result.description?.toLowerCase()).toContain("auto");
  });
});
