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
    }>;
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

  const seenUuids = new Set<string>();
  const turns: NormalizedTurn[] = [];

  for (const record of records) {
    // Skip compact summaries and compact boundaries
    if (record.isCompactSummary === true) continue;
    if (record.type === "compact_boundary") continue;

    // Only process assistant messages
    if (record.type !== "assistant") continue;

    // Deduplicate by uuid
    if (record.uuid) {
      if (seenUuids.has(record.uuid)) continue;
      seenUuids.add(record.uuid);
    }

    turns.push(recordToTurn(record, "unknown"));
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
