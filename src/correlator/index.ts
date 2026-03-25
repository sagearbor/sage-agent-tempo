import {
  type BuildLog,
  type SessionSummary,
  type ParsedChecklist,
  type GitCommit,
  type TestResults,
  type ChecklistItemResult,
  type TokenUsage,
  type NormalizedTurn,
  BuildLogSchema,
} from "../parsers/types.js";
import { generateTimeline } from "./timeline.js";
import { generateSummary } from "./summary.js";

export interface CorrelateOptions {
  sessions: SessionSummary[];
  checklist: ParsedChecklist;
  commits?: GitCommit[];
  testResults?: TestResults;
}

export function correlate(opts: CorrelateOptions): BuildLog {
  const { sessions, checklist, commits = [], testResults } = opts;

  const allTurns = sessions.flatMap((s) => s.turns);
  allTurns.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const itemResults = correlateItemsToTurns(checklist, allTurns, commits);

  const buildLog: BuildLog = {
    project: checklist.project,
    agent: sessions[0]?.agent ?? "unknown",
    sessionId: sessions.map((s) => s.sessionId).join(","),
    generatedAt: new Date().toISOString(),
    checklist: {
      source: "developer_checklist.yaml",
      items: itemResults,
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

  buildLog.timeline = generateTimeline(buildLog, sessions);
  buildLog.summary = generateSummary(buildLog, testResults);

  return BuildLogSchema.parse(buildLog);
}

function correlateItemsToTurns(
  checklist: ParsedChecklist,
  turns: NormalizedTurn[],
  commits: GitCommit[]
): ChecklistItemResult[] {
  const assignments = new Map<string, NormalizedTurn[]>();
  for (const item of checklist.items) {
    assignments.set(item.id, []);
  }

  let currentItemId: string | undefined;

  for (const turn of turns) {
    const content = turn.content ?? "";

    // Strategy 1: Explicit mention of checklist item ID
    const mentionedId = findExplicitMention(content, checklist);
    if (mentionedId) {
      currentItemId = mentionedId;
    }

    // Strategy 2: File-based correlation
    if (!currentItemId && turn.filesTouched.length > 0) {
      const fileBasedId = findByFileMatch(turn.filesTouched, checklist);
      if (fileBasedId) {
        currentItemId = fileBasedId;
      }
    }

    // Strategy 3: Temporal — assign to current item
    if (currentItemId && assignments.has(currentItemId)) {
      assignments.get(currentItemId)!.push(turn);
    }
  }

  return checklist.items.map((item) => {
    const itemTurns = assignments.get(item.id) ?? [];
    const tokens = aggregateTokens(itemTurns);
    const toolsUsed = [
      ...new Set(itemTurns.flatMap((t) => t.toolCalls.map((tc) => tc.toolName))),
    ];
    const filesCreated = [
      ...new Set(itemTurns.flatMap((t) => t.filesTouched)),
    ];

    const startedAt = itemTurns.length > 0 ? itemTurns[0].timestamp : undefined;
    const completedAt =
      itemTurns.length > 0 ? itemTurns[itemTurns.length - 1].timestamp : undefined;

    const durationMinutes =
      startedAt && completedAt
        ? (new Date(completedAt).getTime() - new Date(startedAt).getTime()) /
          60000
        : undefined;

    const itemCommits = commits
      .filter((c) => {
        if (!startedAt || !completedAt) return false;
        const ct = new Date(c.timestamp).getTime();
        return (
          ct >= new Date(startedAt).getTime() &&
          ct <= new Date(completedAt).getTime()
        );
      })
      .map((c) => c.sha);

    return {
      id: item.id,
      title: item.title,
      phase: item.phase,
      tags: item.tags,
      status: itemTurns.length > 0 ? ("done" as const) : ("pending" as const),
      startedAt,
      completedAt,
      durationMinutes,
      tokens: tokens.total > 0 ? tokens : undefined,
      turns: itemTurns.length,
      toolsUsed,
      filesCreated,
      filesModified: [],
      tests: { created: 0, passed: 0, failed: 0 },
      gitCommits: itemCommits,
    };
  });
}

function findExplicitMention(
  content: string,
  checklist: ParsedChecklist
): string | undefined {
  const lower = content.toLowerCase();

  // Check for patterns like "Starting 2.1", "item 2.1", "Working on 2.1"
  for (const item of checklist.items) {
    const idPatterns = [
      `starting ${item.id}`,
      `item ${item.id}`,
      `working on ${item.id}`,
      `starting item ${item.id}`,
      `now working on ${item.id}`,
      `moving to ${item.id}`,
    ];
    for (const pattern of idPatterns) {
      if (lower.includes(pattern)) return item.id;
    }

    // Check for title mention
    if (item.title.length > 10 && lower.includes(item.title.toLowerCase())) {
      return item.id;
    }
  }

  return undefined;
}

function findByFileMatch(
  files: string[],
  checklist: ParsedChecklist
): string | undefined {
  for (const item of checklist.items) {
    const acceptance = item.acceptance?.toLowerCase() ?? "";
    for (const file of files) {
      const basename = file.split("/").pop()?.toLowerCase() ?? "";
      if (acceptance.includes(basename)) {
        return item.id;
      }
    }
  }
  return undefined;
}

function aggregateTokens(turns: NormalizedTurn[]): TokenUsage {
  const result = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
  for (const turn of turns) {
    result.input += turn.tokens.input;
    result.output += turn.tokens.output;
    result.cacheRead += turn.tokens.cacheRead;
    result.cacheCreation += turn.tokens.cacheCreation;
    result.total += turn.tokens.total;
  }
  return result;
}

export { generateTimeline } from "./timeline.js";
export { generateSummary } from "./summary.js";
