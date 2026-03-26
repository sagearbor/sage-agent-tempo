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
  selfReportItems?: string[];
}

// ── TEMPO_STATUS extraction ──────────────────────────────────────

export function extractTempoStatus(
  content: string,
): { completed: string[]; inProgress: string[] } | undefined {
  // Look for TEMPO_STATUS block in the content
  const statusBlockMatch = content.match(
    /TEMPO_STATUS:\s*\n((?:\s*-\s+(?:completed|in_progress|discovered):.*\n?)*)/,
  );
  if (!statusBlockMatch) return undefined;

  const block = statusBlockMatch[1];
  const completed: string[] = [];
  const inProgress: string[] = [];

  // Match completed items: - completed: "2.1"
  const completedRe = /^\s*-\s+completed:\s*"([^"]+)"/gm;
  let m: RegExpExecArray | null;
  while ((m = completedRe.exec(block)) !== null) {
    completed.push(m[1]);
  }

  // Match in_progress items: - in_progress: "2.3"
  const inProgressRe = /^\s*-\s+in_progress:\s*"([^"]+)"/gm;
  while ((m = inProgressRe.exec(block)) !== null) {
    inProgress.push(m[1]);
  }

  if (completed.length === 0 && inProgress.length === 0) return undefined;
  return { completed, inProgress };
}

// ── Confidence tracking ──────────────────────────────────────────

type ConfidenceLevel = "high" | "medium" | "low";

export function correlate(opts: CorrelateOptions): BuildLog {
  const { sessions, commits = [], testResults, selfReportItems } = opts;

  // If no checklist provided, auto-infer work blocks from session data
  const checklist = opts.checklist ?? inferWorkBlocks(sessions, commits);

  const allTurns = sessions.flatMap((s) => s.turns);
  allTurns.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const itemResults = correlateItemsToTurns(checklist, allTurns, commits, selfReportItems);

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
  commits: GitCommit[],
  selfReportItems?: string[],
): ChecklistItemResult[] {
  const assignments = new Map<string, NormalizedTurn[]>();
  // Track the confidence level for each item assignment
  const itemConfidence = new Map<string, ConfidenceLevel>();
  // Track TEMPO_STATUS completed/in-progress items found in turn content
  const tempoCompleted = new Set<string>();
  const tempoInProgress = new Set<string>();

  for (const item of checklist.items) {
    assignments.set(item.id, []);
  }

  // Build file-to-item mapping from checklist structure
  const filePatterns = buildFilePatterns(checklist);

  // Track the current item per sessionId — parallel agents each get
  // their own temporal pointer so they don't clobber each other
  const currentItemBySession = new Map<string, string>();

  // Separate bucket for planning turns
  const planningTurns: NormalizedTurn[] = [];

  for (const turn of turns) {
    const content = turn.content ?? "";
    const sid = turn.sessionId;
    let assignedId: string | undefined;
    let confidence: ConfidenceLevel = "low";

    // Skip planning/status turns — don't assign to items or overhead
    if (isPlanningTurn(content)) {
      planningTurns.push(turn);
      continue;
    }

    // Strategy 0: TEMPO_STATUS block (highest priority)
    const tempoStatus = extractTempoStatus(content);
    if (tempoStatus) {
      // Track all mentioned items for status marking
      for (const id of tempoStatus.completed) tempoCompleted.add(id);
      for (const id of tempoStatus.inProgress) tempoInProgress.add(id);

      // Assign this turn to the first mentioned item (completed > in_progress)
      const firstMentioned = tempoStatus.completed[0] ?? tempoStatus.inProgress[0];
      if (firstMentioned && assignments.has(firstMentioned)) {
        assignedId = firstMentioned;
        confidence = "high";
        currentItemBySession.set(sid, firstMentioned);
      }
    }

    // Strategy 1: Explicit mention of checklist item ID or title
    if (!assignedId) {
      const mentionedId = findExplicitMention(content, checklist);
      if (mentionedId) {
        assignedId = mentionedId;
        confidence = "high";
        currentItemBySession.set(sid, mentionedId);
      }
    }

    // Strategy 2: File-path-based correlation (always wins over temporal)
    if (!assignedId && turn.filesTouched.length > 0) {
      const fileBasedId = findByFileMatch(turn.filesTouched, checklist, filePatterns);
      if (fileBasedId) {
        assignedId = fileBasedId;
        confidence = "medium";
        currentItemBySession.set(sid, fileBasedId);
      }
    }

    // Strategy 3: Temporal fallback — use the current item for THIS session only
    // This prevents parallel agents from bleeding into each other's items
    if (!assignedId) {
      assignedId = currentItemBySession.get(sid);
      confidence = "low";
    }

    if (assignedId && assignments.has(assignedId)) {
      assignments.get(assignedId)!.push(turn);
      // Upgrade confidence: keep the highest confidence seen for this item
      const existing = itemConfidence.get(assignedId);
      if (!existing || confidenceRank(confidence) > confidenceRank(existing)) {
        itemConfidence.set(assignedId, confidence);
      }
    } else {
      // Overhead bucket — unmatched turns (planning, discussion, etc.)
      if (!assignments.has("_overhead")) {
        assignments.set("_overhead", []);
      }
      assignments.get("_overhead")!.push(turn);
    }
  }

  // Self-report rescue: re-assign overhead turns to self-reported items
  if (selfReportItems && selfReportItems.length > 0) {
    const overheadTurns = assignments.get("_overhead") ?? [];
    if (overheadTurns.length > 0) {
      const rescued: NormalizedTurn[] = [];
      for (const turn of overheadTurns) {
        const turnTime = new Date(turn.timestamp).getTime();
        let reassigned = false;

        for (const itemId of selfReportItems) {
          if (!assignments.has(itemId)) continue;
          const itemTurns = assignments.get(itemId)!;
          if (itemTurns.length === 0) {
            // No existing turns — assign overhead turn directly
            itemTurns.push(turn);
            itemConfidence.set(itemId, "high");
            reassigned = true;
            break;
          }

          // Check if this overhead turn overlaps the item's time range
          const itemStart = new Date(itemTurns[0].timestamp).getTime();
          const itemEnd = new Date(itemTurns[itemTurns.length - 1].timestamp).getTime();
          // Extend range by 5 minutes on each side for proximity matching
          if (turnTime >= itemStart - 5 * 60000 && turnTime <= itemEnd + 5 * 60000) {
            itemTurns.push(turn);
            itemConfidence.set(itemId, "high");
            reassigned = true;
            break;
          }
        }

        if (!reassigned) {
          rescued.push(turn);
        }
      }

      // Update overhead with remaining un-rescued turns
      assignments.set("_overhead", rescued);
    }
  }

  // Mark TEMPO_STATUS and self-reported items with high confidence
  for (const id of tempoCompleted) {
    itemConfidence.set(id, "high");
  }
  for (const id of tempoInProgress) {
    if (!itemConfidence.has(id)) {
      itemConfidence.set(id, "high");
    }
  }
  if (selfReportItems) {
    for (const id of selfReportItems) {
      itemConfidence.set(id, "high");
    }
  }

  // Build the overhead item from unmatched turns
  const overheadTurns = assignments.get("_overhead") ?? [];
  const overheadItem: ChecklistItemResult | undefined =
    overheadTurns.length > 0
      ? buildItemResult("_overhead", "Planning & overhead", "overhead", [], overheadTurns, commits, "low")
      : undefined;

  const results = checklist.items.map((item) => {
    const itemTurns = assignments.get(item.id) ?? [];
    const confidence = itemConfidence.get(item.id) ?? "low";

    // Determine status: TEMPO_STATUS can override
    let status: "done" | "in_progress" | "pending" | "skipped";
    if (tempoCompleted.has(item.id)) {
      status = "done";
    } else if (tempoInProgress.has(item.id)) {
      status = "in_progress";
    } else if (itemTurns.length > 0) {
      status = "done";
    } else {
      status = "pending";
    }

    return buildItemResult(
      item.id, item.title, item.phase, item.tags,
      itemTurns, commits, confidence, status,
    );
  });

  if (overheadItem) {
    results.push(overheadItem);
  }

  return results;
}

function confidenceRank(level: ConfidenceLevel): number {
  switch (level) {
    case "high": return 3;
    case "medium": return 2;
    case "low": return 1;
  }
}

function buildItemResult(
  id: string,
  title: string,
  phase: string,
  tags: string[],
  itemTurns: NormalizedTurn[],
  commits: GitCommit[],
  confidence: ConfidenceLevel = "low",
  statusOverride?: "done" | "in_progress" | "pending" | "skipped",
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

  const status = statusOverride ?? (itemTurns.length > 0 ? ("done" as const) : ("pending" as const));

  return {
    id,
    title,
    phase,
    tags,
    status,
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
    confidence,
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
      `completed item ${item.id}`,
      `completed ${item.id}`,
    ];
    for (const pattern of idPatterns) {
      if (lower.includes(pattern)) return item.id;
    }

    // Check for title mention
    if (item.title.length > 10 && lower.includes(item.title.toLowerCase())) {
      return item.id;
    }
  }

  // Check for range patterns like "Starting items 4.1-4.7" — return the first item in range
  const rangeMatch = lower.match(/starting items?\s+(\d+\.\d+)\s*[-–]\s*(\d+\.\d+)/);
  if (rangeMatch) {
    const startId = rangeMatch[1];
    const item = checklist.items.find((i) => i.id === startId);
    if (item) return item.id;
  }

  // Check for "Starting item X.Y (part N)" patterns
  const partMatch = lower.match(/starting item\s+(\d+\.\d+)\s*\(part/);
  if (partMatch) {
    const item = checklist.items.find((i) => i.id === partMatch[1]);
    if (item) return item.id;
  }

  // Strategy: Work intent patterns — match against item titles (lower priority than explicit ID)
  const intentPatterns = [
    /(?:let me|now i(?:'ll| will)|i(?:'ll| will) now|i need to|i should)\s+(?:build|create|implement|write|set up|design|fix|add|configure)\s+(.+?)(?:\.|$)/i,
    /(?:building|creating|implementing|writing|setting up|designing|fixing|adding|configuring)\s+(?:the\s+)?(.+?)(?:\.|$)/i,
  ];

  for (const pattern of intentPatterns) {
    const match = content.match(pattern);
    if (match?.[1]) {
      const intentId = findByTitleSimilarity(match[1], checklist);
      if (intentId) return intentId;
    }
  }

  return undefined;
}

/**
 * Compute Jaccard similarity between two sets of words.
 * Returns intersection / union.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Tokenize a string into lowercase words, filtering out common stop words.
 */
function tokenize(text: string): Set<string> {
  const stopWords = new Set(["the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "with", "is", "it"]);
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w));
  return new Set(words);
}

/**
 * Find the best-matching checklist item by title similarity using Jaccard index.
 * Returns the item ID with highest similarity if it's above the 0.3 threshold.
 */
function findByTitleSimilarity(text: string, checklist: ParsedChecklist): string | undefined {
  const inputTokens = tokenize(text);
  if (inputTokens.size === 0) return undefined;

  let bestId: string | undefined;
  let bestScore = 0;

  for (const item of checklist.items) {
    const titleTokens = tokenize(item.title);
    if (titleTokens.size === 0) continue;

    const score = jaccardSimilarity(inputTokens, titleTokens);
    if (score > bestScore) {
      bestScore = score;
      bestId = item.id;
    }
  }

  return bestScore >= 0.3 ? bestId : undefined;
}

/**
 * Detect whether a turn is purely planning/status rather than actual work.
 * Planning turns should be categorized separately — not assigned to items
 * and not counted as overhead.
 */
export function isPlanningTurn(content: string): boolean {
  if (!content || content.trim().length === 0) return false;

  const trimmed = content.trim();

  // Summary patterns at the start of the turn
  const summaryPatterns = [
    /^all\s+\d+\s+agents?\s+completed/i,
    /^here'?s\s+what\s+was\s+done/i,
    /^\*{0,2}summary:?\*{0,2}/i,
  ];
  for (const pattern of summaryPatterns) {
    if (pattern.test(trimmed)) return true;
  }

  // Content is only questions (no actionable work)
  const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
  const allQuestions = lines.every((line) => {
    const l = line.trim();
    return (
      /^(should\s+we|do\s+you\s+want\s+me\s+to|would\s+you\s+like|shall\s+i)\b/i.test(l) ||
      l.endsWith("?")
    );
  });
  if (allQuestions && lines.length > 0) return true;

  // Content is only file listing/reading without modifications
  const onlyReading = lines.every((line) => {
    const l = line.trim();
    return (
      /^(reading|listing|checking|looking at|examining|reviewing)\s+/i.test(l) ||
      /^(file|directory|folder):/i.test(l) ||
      /^[-•]\s*(src|lib|test|config|package)\//i.test(l) ||
      l === ""
    );
  });
  if (onlyReading && lines.length > 0) return true;

  return false;
}

/**
 * Build a mapping of file path patterns to checklist item IDs.
 * Works for ANY project by extracting paths from:
 * 1. Acceptance criteria (file paths mentioned in the text)
 * 2. Notes field
 * 3. Title (extract path-like segments: "src/foo/bar.ts exports:" -> "src/foo/bar")
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
