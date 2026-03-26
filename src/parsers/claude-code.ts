/**
 * Claude Code JSONL parser
 *
 * Parses Claude Code session JSONL files into normalized turns and session summaries.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  AgentParser,
  NormalizedTurn,
  SessionSummary,
  TokenUsage,
} from "./types.js";
import { parseTestOutput } from "../collectors/test-results.js";

// ── Internal helpers ─────────────────────────────────────────────

interface RawRecord {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string;
  isCompactSummary?: boolean;
  costUSD?: number;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    content?: Array<{
      type: string;
      name?: string;
      input?: Record<string, unknown>;
      text?: string;
      content?: string | Array<{ type: string; text?: string }>;
      tool_use_id?: string;
    }>;
  };
}

// ── Test output detection ────────────────────────────────────────

const TEST_OUTPUT_PATTERNS = [
  /Tests?\s+\d+\s+passed/i,
  /Tests:\s+\d+\s+passed/i,
  /\d+\s+pass(?:ed|ing)/i,
  /\bPASS\b/,
  /\bFAIL\b/,
  /\d+\s+passed.*in\s+\d/i, // pytest-style summary
];

function looksLikeTestOutput(text: string): boolean {
  return TEST_OUTPUT_PATTERNS.some((re) => re.test(text));
}

/**
 * Extract text from tool_result content blocks in a record.
 * tool_result blocks can have `content` as a string or as an array of
 * { type: "text", text: "..." } objects.
 */
function extractToolResultTexts(record: RawRecord): string[] {
  const texts: string[] = [];
  if (!record.message?.content) return texts;

  for (const block of record.message.content) {
    if (block.type !== "tool_result") continue;

    if (typeof block.content === "string") {
      texts.push(block.content);
    } else if (Array.isArray(block.content)) {
      for (const inner of block.content) {
        if (inner.type === "text" && inner.text) {
          texts.push(inner.text);
        }
      }
    }
    // Some JSONL files put the result directly in `text`
    if (block.text) {
      texts.push(block.text);
    }
  }
  return texts;
}

/**
 * Parse test results from tool_result text if it looks like test runner output.
 * Returns undefined if no test output is detected.
 */
function extractTestResults(
  record: RawRecord,
): NormalizedTurn["testResults"] | undefined {
  const texts = extractToolResultTexts(record);
  if (texts.length === 0) return undefined;

  const combined = texts.join("\n");
  if (!looksLikeTestOutput(combined)) return undefined;

  // Use the existing parseTestOutput with "unknown" framework for auto-detection
  const parsed = parseTestOutput(combined, "unknown");
  if (parsed.total === 0 && parsed.passed === 0 && parsed.failed === 0) {
    return undefined;
  }

  return {
    passed: parsed.passed,
    failed: parsed.failed,
    skipped: parsed.skipped,
  };
}

function extractFilePaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const filePath = input["file_path"] ?? input["path"];
  if (typeof filePath === "string" && filePath.length > 0) {
    paths.push(filePath);
  }
  return paths;
}

function buildTokenUsage(record: RawRecord): TokenUsage {
  const usage = record.message?.usage;
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheCreation,
    total: input + output + cacheRead + cacheCreation,
  };
}

function sumTokens(usages: TokenUsage[]): TokenUsage {
  const result: TokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    total: 0,
  };
  for (const u of usages) {
    result.input += u.input;
    result.output += u.output;
    result.cacheRead += u.cacheRead;
    result.cacheCreation += u.cacheCreation;
    result.total += u.total;
  }
  return result;
}

function parseLines(raw: string): RawRecord[] {
  const records: RawRecord[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      records.push(JSON.parse(trimmed) as RawRecord);
    } catch {
      console.error(`[claude-code parser] Skipping malformed JSONL line: ${trimmed.slice(0, 120)}...`);
    }
  }
  return records;
}

function recordToTurn(record: RawRecord, fallbackSessionId: string): NormalizedTurn {
  const toolCalls: NormalizedTurn["toolCalls"] = [];
  const filesTouched: string[] = [];

  if (record.message?.content) {
    for (const block of record.message.content) {
      if (block.type === "tool_use" && block.name) {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const paths = extractFilePaths(input);
        filesTouched.push(...paths);
        toolCalls.push({
          toolName: block.name,
          filePath: paths[0],
          input,
        });
      }
    }
  }

  return {
    timestamp: record.timestamp ?? new Date(0).toISOString(),
    sessionId: record.sessionId ?? fallbackSessionId,
    uuid: record.uuid,
    parentUuid: record.parentUuid,
    model: record.message?.model,
    tokens: buildTokenUsage(record),
    toolCalls,
    filesTouched: [...new Set(filesTouched)],
    content: record.message?.content
      ?.filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("\n"),
    isSubagent: false,
  };
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Parse a single Claude Code JSONL session file into normalized turns.
 */
export async function parseSession(jsonlPath: string): Promise<NormalizedTurn[]> {
  const absPath = resolve(jsonlPath);
  const raw = readFileSync(absPath, "utf-8");
  const records = parseLines(raw);

  // The filename (without extension) is the canonical sessionId for main sessions.
  // In continuation sessions, the JSONL contains inherited parent records
  // with different sessionIds — filter those out to avoid double-counting.
  // Subagent files (agent-*.jsonl) use the parent's sessionId in records,
  // so we don't apply filename filtering to them.
  const fileName = absPath.split("/").pop()?.replace(/\.jsonl$/, "") ?? "";
  const isSubagentFile = fileName.startsWith("agent-");
  // Only apply sessionId filtering when the filename looks like a UUID (real CC session files)
  const isUuidFilename = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(fileName);
  const canonicalSessionId = (!isSubagentFile && isUuidFilename) ? fileName : undefined;

  // For subagent files, extract the first user message as task context.
  // Orchestrators often include "Starting item X.Y" in the subagent prompt,
  // which we prepend to the first assistant turn's content so the correlator
  // can match it to a checklist item.
  let subagentTaskContext: string | undefined;
  if (isSubagentFile) {
    for (const record of records) {
      if (record.type === "user") {
        const content = record.message?.content;
        if (typeof content === "string") {
          subagentTaskContext = content;
        } else if (Array.isArray(content)) {
          subagentTaskContext = content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join("\n");
        }
        break;
      }
    }
  }

  const seenUuids = new Set<string>();
  const turns: NormalizedTurn[] = [];
  let isFirstTurn = true;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];

    // Skip compact summaries and compact boundaries
    if (record.isCompactSummary === true) continue;
    if (record.type === "compact_boundary") continue;

    // Only process assistant messages
    if (record.type !== "assistant") continue;

    // For main session files: skip inherited parent records (different sessionId)
    if (canonicalSessionId && record.sessionId && record.sessionId !== canonicalSessionId) {
      continue;
    }

    // Deduplicate by uuid
    if (record.uuid) {
      if (seenUuids.has(record.uuid)) continue;
      seenUuids.add(record.uuid);
    }

    // For subagent files, use the agent ID from the filename as a pseudo-sessionId
    // so subagent turns get their own session, not merged with the parent
    const sessionId = isSubagentFile ? fileName : (record.sessionId ?? "unknown");

    const turn = recordToTurn(record, sessionId);

    // Prepend subagent task context to the first turn so the correlator
    // can match "Starting item X.Y" from the orchestrator's prompt
    if (isFirstTurn && subagentTaskContext && turn.content) {
      turn.content = subagentTaskContext + "\n" + turn.content;
    } else if (isFirstTurn && subagentTaskContext) {
      turn.content = subagentTaskContext;
    }
    isFirstTurn = false;

    // Look ahead for tool_result records (in the next user message) that
    // contain test runner output. Tool results follow the assistant turn
    // that issued the tool_use.
    for (let j = i + 1; j < records.length; j++) {
      const next = records[j];
      // Stop at the next assistant message — tool results belong to THIS turn
      if (next.type === "assistant") break;
      // Skip non-user records
      if (next.type !== "user") continue;

      const testResults = extractTestResults(next);
      if (testResults) {
        // Merge: if multiple tool results have test output, accumulate
        if (turn.testResults) {
          turn.testResults.passed += testResults.passed;
          turn.testResults.failed += testResults.failed;
          turn.testResults.skipped += testResults.skipped;
        } else {
          turn.testResults = testResults;
        }
      }
    }

    turns.push(turn);
  }

  return turns;
}

/**
 * Scan a project directory for JSONL files and build session summaries.
 */
export async function parseProjectSessions(
  projectDir: string,
): Promise<SessionSummary[]> {
  const absDir = resolve(projectDir);
  const jsonlFiles = findJsonlFiles(absDir);
  const summaries: SessionSummary[] = [];

  for (const filePath of jsonlFiles) {
    const turns = await parseSession(filePath);
    if (turns.length === 0) continue;

    // Group turns by sessionId to handle continuation sessions
    const bySession = new Map<string, NormalizedTurn[]>();
    for (const turn of turns) {
      const sid = turn.sessionId;
      if (!bySession.has(sid)) bySession.set(sid, []);
      bySession.get(sid)!.push(turn);
    }

    for (const [sessionId, sessionTurns] of bySession) {
      const timestamps = sessionTurns
        .map((t) => new Date(t.timestamp).getTime())
        .filter((t) => !isNaN(t));

      const startMs = Math.min(...timestamps);
      const endMs = Math.max(...timestamps);
      const durationMinutes = timestamps.length > 0
        ? (endMs - startMs) / 60_000
        : 0;

      const models = sessionTurns
        .map((t) => t.model)
        .filter((m): m is string => !!m);

      summaries.push({
        sessionId,
        agent: "claude-code",
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(endMs).toISOString(),
        durationMinutes: Math.round(durationMinutes * 100) / 100,
        turns: sessionTurns,
        totalTokens: sumTokens(sessionTurns.map((t) => t.tokens)),
        model: models[0],
      });
    }
  }

  return summaries;
}

// ── File discovery ───────────────────────────────────────────────

function findJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          results.push(...findJsonlFiles(full));
        } else if (entry.endsWith(".jsonl")) {
          results.push(full);
        }
      } catch {
        // Skip entries we can't stat (permissions, broken symlinks, etc.)
      }
    }
  } catch {
    // Skip directories we can't read
  }
  return results;
}

// ── AgentParser implementation ───────────────────────────────────

export const claudeCodeParser: AgentParser = {
  parseSession,
  async findSessions(baseDir: string): Promise<string[]> {
    return findJsonlFiles(resolve(baseDir));
  },
};
