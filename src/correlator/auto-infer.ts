/**
 * Auto-infer work blocks from session data when no developer_checklist.yaml exists.
 *
 * Supports three scenarios:
 * 1. No checklist at all — groups turns by time gaps and file patterns
 * 2. Skill-based announcements — detects "Now I'll work on...", "Let me build..." etc.
 * 3. Mid-stream adoption — works from available data forward
 */

import type {
  SessionSummary,
  GitCommit,
  ParsedChecklist,
  ParsedChecklistItem,
  NormalizedTurn,
} from "../parsers/types.js";

/** Minimum gap in milliseconds to split into a new work block (5 minutes). */
const GAP_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Patterns that indicate the agent is announcing a new unit of work.
 * Captured group 1 is the description of the work.
 */
const ANNOUNCEMENT_PATTERNS: RegExp[] = [
  /(?:now i'll work on|now i will work on)\s+(.+?)(?:\.|$)/i,
  /(?:let me build|let me create|let me implement|let me set up|let me write)\s+(.+?)(?:\.|$)/i,
  /(?:next step:\s*)(.+?)(?:\.|$)/i,
  /(?:starting item\s+)(\S+)/i,
  /(?:moving on to)\s+(.+?)(?:\.|$)/i,
  /(?:working on)\s+(.+?)(?:\.|$)/i,
];

interface RawBlock {
  turns: NormalizedTurn[];
  startedAt: string;
  endedAt: string;
  label?: string;
}

/**
 * Create a synthetic ParsedChecklist from session data when no YAML checklist exists.
 */
export function inferWorkBlocks(
  sessions: SessionSummary[],
  commits: GitCommit[] = [],
): ParsedChecklist {
  if (sessions.length === 0) {
    return { project: "auto-inferred", items: [] };
  }

  // Flatten and sort all turns chronologically
  const allTurns = sessions.flatMap((s) => s.turns);
  allTurns.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  // Step 1: Split turns into raw blocks by time gaps
  let rawBlocks = splitByTimeGaps(allTurns);

  // Step 2: Further split blocks at git commit boundaries
  rawBlocks = splitAtCommitBoundaries(rawBlocks, commits);

  // Step 3: Try to label blocks from agent announcements (Scenario 2)
  labelFromAnnouncements(rawBlocks);

  // Step 4: Label remaining blocks by primary directory/files worked on
  labelFromFiles(rawBlocks);

  // Step 5: Convert to ParsedChecklist items, grouping into phases by session
  return buildChecklist(rawBlocks, sessions);
}

/**
 * Split turns into blocks wherever there is a gap > GAP_THRESHOLD_MS.
 */
function splitByTimeGaps(turns: NormalizedTurn[]): RawBlock[] {
  if (turns.length === 0) return [];

  const blocks: RawBlock[] = [];
  let current: NormalizedTurn[] = [turns[0]];

  for (let i = 1; i < turns.length; i++) {
    const prevTime = new Date(turns[i - 1].timestamp).getTime();
    const currTime = new Date(turns[i].timestamp).getTime();

    if (currTime - prevTime > GAP_THRESHOLD_MS) {
      blocks.push(blockFromTurns(current));
      current = [turns[i]];
    } else {
      current.push(turns[i]);
    }
  }

  if (current.length > 0) {
    blocks.push(blockFromTurns(current));
  }

  return blocks;
}

/**
 * Further split blocks at git commit timestamps.
 * A commit within a block creates a boundary: turns before the commit go into one block,
 * turns after go into another.
 */
function splitAtCommitBoundaries(
  blocks: RawBlock[],
  commits: GitCommit[],
): RawBlock[] {
  if (commits.length === 0) return blocks;

  const commitTimes = commits
    .map((c) => new Date(c.timestamp).getTime())
    .sort((a, b) => a - b);

  const result: RawBlock[] = [];

  for (const block of blocks) {
    const blockStart = new Date(block.startedAt).getTime();
    const blockEnd = new Date(block.endedAt).getTime();

    // Find commits that fall within this block (not at the very start or end)
    const splitPoints = commitTimes.filter(
      (t) => t > blockStart && t < blockEnd,
    );

    if (splitPoints.length === 0) {
      result.push(block);
      continue;
    }

    // Split the block's turns at each commit time
    let remaining = [...block.turns];
    for (const splitTime of splitPoints) {
      const before = remaining.filter(
        (t) => new Date(t.timestamp).getTime() <= splitTime,
      );
      const after = remaining.filter(
        (t) => new Date(t.timestamp).getTime() > splitTime,
      );

      if (before.length > 0) {
        result.push(blockFromTurns(before));
      }
      remaining = after;
    }
    if (remaining.length > 0) {
      result.push(blockFromTurns(remaining));
    }
  }

  return result;
}

/**
 * Attempt to label blocks by detecting agent work announcements in turn content.
 */
function labelFromAnnouncements(blocks: RawBlock[]): void {
  for (const block of blocks) {
    if (block.label) continue;

    for (const turn of block.turns) {
      const content = turn.content ?? "";
      for (const pattern of ANNOUNCEMENT_PATTERNS) {
        const match = content.match(pattern);
        if (match?.[1]) {
          // Truncate long labels
          block.label = match[1].trim().slice(0, 60);
          break;
        }
      }
      if (block.label) break;
    }
  }
}

/**
 * Label blocks by the primary directory or files being worked on.
 */
function labelFromFiles(blocks: RawBlock[]): void {
  for (const block of blocks) {
    if (block.label) continue;

    const allFiles = block.turns.flatMap((t) => t.filesTouched);
    if (allFiles.length === 0) {
      // Fall back to tool-based labeling
      const tools = block.turns.flatMap((t) => t.toolCalls.map((tc) => tc.toolName));
      if (tools.length > 0) {
        const topTool = mostCommon(tools);
        block.label = `${topTool} operations`;
      } else {
        block.label = "general work";
      }
      continue;
    }

    // Find the most common top-level directory
    const dirs = allFiles.map((f) => {
      const parts = f.replace(/^\//, "").split("/");
      // Use first two path segments for specificity, or the file itself
      return parts.length > 1 ? `${parts[0]}/${parts[1]}/` : parts[0];
    });

    const primaryDir = mostCommon(dirs);
    block.label = `${primaryDir} work`;
  }
}

/**
 * Convert raw blocks into a ParsedChecklist.
 * Groups blocks into phases based on the session they belong to.
 */
function buildChecklist(
  blocks: RawBlock[],
  sessions: SessionSummary[],
): ParsedChecklist {
  // Build a session-time lookup
  const sessionRanges = sessions.map((s) => ({
    id: s.sessionId,
    start: new Date(s.startedAt).getTime(),
    end: new Date(s.endedAt).getTime(),
  }));

  // Group blocks into phases by session
  const phaseMap = new Map<string, RawBlock[]>();

  for (const block of blocks) {
    const blockStart = new Date(block.startedAt).getTime();
    const matchingSession = sessionRanges.find(
      (s) => blockStart >= s.start && blockStart <= s.end,
    );

    const phaseKey = matchingSession
      ? `session-${matchingSession.id.slice(0, 8)}`
      : "unattributed";

    if (!phaseMap.has(phaseKey)) {
      phaseMap.set(phaseKey, []);
    }
    phaseMap.get(phaseKey)!.push(block);
  }

  // Flatten into ParsedChecklistItems
  const items: ParsedChecklistItem[] = [];
  let globalIndex = 1;

  const phases = [...phaseMap.entries()];
  for (let phaseIdx = 0; phaseIdx < phases.length; phaseIdx++) {
    const [phaseKey, phaseBlocks] = phases[phaseIdx];
    const phaseNumber = phaseIdx + 1;

    for (let blockIdx = 0; blockIdx < phaseBlocks.length; blockIdx++) {
      const block = phaseBlocks[blockIdx];
      const itemId = `${phaseNumber}.${blockIdx + 1}`;

      // Infer tags from file paths
      const allFiles = block.turns.flatMap((t) => t.filesTouched);
      const tags = inferTags(allFiles);

      items.push({
        id: itemId,
        title: block.label ?? `Work block ${globalIndex}`,
        phase: phaseKey,
        phaseName: `Session ${phaseNumber}`,
        tags,
        dependsOn: [],
      });

      globalIndex++;
    }
  }

  return {
    project: "auto-inferred",
    description: "Automatically inferred from session data (no checklist provided)",
    items,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function blockFromTurns(turns: NormalizedTurn[]): RawBlock {
  return {
    turns,
    startedAt: turns[0].timestamp,
    endedAt: turns[turns.length - 1].timestamp,
  };
}

function mostCommon(arr: string[]): string {
  const counts = new Map<string, number>();
  for (const item of arr) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  let best = arr[0];
  let bestCount = 0;
  for (const [item, count] of counts) {
    if (count > bestCount) {
      best = item;
      bestCount = count;
    }
  }
  return best;
}

function inferTags(files: string[]): string[] {
  const tags = new Set<string>();
  for (const f of files) {
    const lower = f.toLowerCase();
    if (lower.includes("test") || lower.includes("spec")) tags.add("tests");
    else if (lower.includes("readme") || lower.includes("doc") || lower.endsWith(".md")) tags.add("docs");
    else if (lower.match(/\.(json|ya?ml|toml|ini|env|config)$/)) tags.add("config");
    else if (lower.includes("src/") || lower.includes("lib/")) {
      if (lower.includes("frontend") || lower.includes("component") || lower.includes("page")) {
        tags.add("frontend");
      } else {
        tags.add("backend");
      }
    }
  }
  return [...tags];
}
