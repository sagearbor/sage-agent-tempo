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
import { inferWorkBlocks } from "./auto-infer.js";

export interface CorrelateOptions {
  sessions: SessionSummary[];
  checklist?: ParsedChecklist;
  commits?: GitCommit[];
  testResults?: TestResults;
}

export function correlate(opts: CorrelateOptions): BuildLog {
  const { sessions, commits = [], testResults } = opts;

  // If no checklist provided, auto-infer work blocks from session data
  const checklist = opts.checklist ?? inferWorkBlocks(sessions, commits);

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
      source: opts.checklist ? "developer_checklist.yaml" : "auto-inferred",
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
      modelUsage: [],
    },
    timeline: [],
  };

  buildLog.timeline = generateTimeline(buildLog, sessions);
  buildLog.summary = generateSummary(buildLog, { testResults, turns: allTurns });

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

  // Build file-to-item mapping from checklist structure
  const filePatterns = buildFilePatterns(checklist);

  // Track the current item per sessionId — parallel agents each get
  // their own temporal pointer so they don't clobber each other
  const currentItemBySession = new Map<string, string>();

  for (const turn of turns) {
    const content = turn.content ?? "";
    const sid = turn.sessionId;
    let assignedId: string | undefined;

    // Strategy 1: Explicit mention of checklist item ID or title (highest priority)
    const mentionedId = findExplicitMention(content, checklist);
    if (mentionedId) {
      assignedId = mentionedId;
      currentItemBySession.set(sid, mentionedId);
    }

    // Strategy 2: File-path-based correlation (always wins over temporal)
    if (!assignedId && turn.filesTouched.length > 0) {
      const fileBasedId = findByFileMatch(turn.filesTouched, checklist, filePatterns);
      if (fileBasedId) {
        assignedId = fileBasedId;
        currentItemBySession.set(sid, fileBasedId);
      }
    }

    // Strategy 3: Temporal fallback — use the current item for THIS session only
    // This prevents parallel agents from bleeding into each other's items
    if (!assignedId) {
      assignedId = currentItemBySession.get(sid);
    }

    if (assignedId && assignments.has(assignedId)) {
      assignments.get(assignedId)!.push(turn);
    } else {
      // Overhead bucket — unmatched turns (planning, discussion, etc.)
      if (!assignments.has("_overhead")) {
        assignments.set("_overhead", []);
      }
      assignments.get("_overhead")!.push(turn);
    }
  }

  // Build the overhead item from unmatched turns
  const overheadTurns = assignments.get("_overhead") ?? [];
  const overheadItem: ChecklistItemResult | undefined =
    overheadTurns.length > 0
      ? buildItemResult("_overhead", "Planning & overhead", "overhead", [], overheadTurns, commits)
      : undefined;

  const results = checklist.items.map((item) =>
    buildItemResult(item.id, item.title, item.phase, item.tags, assignments.get(item.id) ?? [], commits)
  );

  if (overheadItem) {
    results.push(overheadItem);
  }

  return results;
}

function buildItemResult(
  id: string,
  title: string,
  phase: string,
  tags: string[],
  itemTurns: NormalizedTurn[],
  commits: GitCommit[]
): ChecklistItemResult {
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
    id,
    title,
    phase,
    tags,
    status: itemTurns.length > 0 ? ("done" as const) : ("pending" as const),
    startedAt,
    completedAt,
    durationMinutes,
    tokens: tokens.total > 0 ? tokens : undefined,
    turns: itemTurns.length,
    toolsUsed,
    filesCreated,
    filesModified: [],
    tests: aggregateTestResults(itemTurns),
    gitCommits: itemCommits,
  };
}

/**
 * Aggregate test results from turns that have them.
 * Uses the *last* test run's results (most representative of final state),
 * and counts the total number of test runs as "created".
 */
function aggregateTestResults(
  turns: NormalizedTurn[],
): { created: number; passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  let totalRuns = 0;

  for (const turn of turns) {
    if (turn.testResults) {
      // Take the latest test run's results (overwrite previous)
      passed = turn.testResults.passed;
      failed = turn.testResults.failed;
      totalRuns++;
    }
  }

  return {
    created: totalRuns > 0 ? passed + failed : 0,
    passed,
    failed,
  };
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

/**
 * Build a mapping of file path patterns to checklist item IDs.
 * Works for ANY project by extracting paths from:
 * 1. Acceptance criteria (file paths mentioned in the text)
 * 2. Notes field
 * 3. Title (extract path-like segments: "src/foo/bar.ts exports:" → "src/foo/bar")
 *
 * Patterns are sorted longest-first so more specific paths match before
 * broad directory patterns.
 */
function buildFilePatterns(
  checklist: ParsedChecklist
): Map<string, string> {
  const entries: Array<[string, string]> = [];

  for (const item of checklist.items) {
    // Combine all text fields to extract paths from
    const text = [
      item.acceptance ?? "",
      item.notes ?? "",
      item.title,
    ].join("\n");

    // Extract file/directory paths like: src/parsers/types.ts, package.json, discovery/
    // Matches: word chars, dots, hyphens, slashes — must have at least one slash or dot
    const pathMatches = text.match(
      /(?:^|[\s,(`])([a-zA-Z0-9_./\-]+(?:\/[a-zA-Z0-9_.\-*]+)+\/?|[a-zA-Z0-9_\-]+\.[a-zA-Z0-9]+)/gm
    ) ?? [];

    for (const raw of pathMatches) {
      const p = raw.trim().replace(/^[(`\s,]+/, "").toLowerCase();
      // Skip very short matches or common false positives
      if (p.length < 4) continue;
      if (/^\d+\.\d+$/.test(p)) continue; // skip version numbers like "3.24.0"
      if (p.startsWith("http")) continue;

      // Strip trailing punctuation
      const cleaned = p.replace(/[),:]+$/, "");
      if (cleaned.length >= 4) {
        entries.push([cleaned, item.id]);
      }
    }
  }

  // Sort longest patterns first — more specific paths should match before directories
  entries.sort((a, b) => b[0].length - a[0].length);

  return new Map(entries);
}

function findByFileMatch(
  files: string[],
  checklist: ParsedChecklist,
  filePatterns: Map<string, string>
): string | undefined {
  for (const file of files) {
    const lower = file.toLowerCase();

    // Check against pattern map (most specific wins)
    for (const [pattern, itemId] of filePatterns) {
      if (lower.includes(pattern)) {
        return itemId;
      }
    }

    // Fall back to acceptance text matching
    const basename = file.split("/").pop()?.toLowerCase() ?? "";
    for (const item of checklist.items) {
      const acceptance = item.acceptance?.toLowerCase() ?? "";
      if (basename.length > 3 && acceptance.includes(basename)) {
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
