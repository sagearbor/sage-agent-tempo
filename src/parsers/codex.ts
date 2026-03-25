/**
 * Codex CLI JSONL parser for sage-agent-tempo.
 *
 * Codex sessions live at ~/.codex/sessions/YYYY/MM/DD/*.jsonl.
 * Token counts are CUMULATIVE — this parser computes per-turn deltas.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { NormalizedTurn, SessionSummary, TokenUsage, AgentParser } from "./types.js";

// ── Internal helpers ─────────────────────────────────────────────

interface CodexTokenCount {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  total_tokens: number;
}

interface CodexRecord {
  type?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any;
  timestamp?: string;
  session_id?: string;
  model?: string;
}

function safeParseLine(line: string): CodexRecord | null {
  try {
    return JSON.parse(line) as CodexRecord;
  } catch {
    console.warn(`[codex-parser] skipping malformed JSONL line: ${line.slice(0, 120)}`);
    return null;
  }
}

function computeDelta(
  current: CodexTokenCount,
  previous: CodexTokenCount | null,
): TokenUsage {
  if (!previous) {
    return {
      input: current.input_tokens,
      output: current.output_tokens,
      cacheRead: current.cache_read_tokens ?? 0,
      cacheCreation: current.cache_creation_tokens ?? 0,
      total: current.total_tokens,
    };
  }
  const input = current.input_tokens - previous.input_tokens;
  const output = current.output_tokens - previous.output_tokens;
  const cacheRead = (current.cache_read_tokens ?? 0) - (previous.cache_read_tokens ?? 0);
  const cacheCreation =
    (current.cache_creation_tokens ?? 0) - (previous.cache_creation_tokens ?? 0);
  const total = current.total_tokens - previous.total_tokens;
  return { input, output, cacheRead, cacheCreation, total };
}

function extractFilePath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ["file_path", "path", "filePath", "filename"]) {
    if (typeof input[key] === "string") return input[key] as string;
  }
  return undefined;
}

/**
 * Recursively find all *.jsonl files under `dir`.
 */
function findJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        results.push(...findJsonlFiles(full));
      } else if (entry.endsWith(".jsonl")) {
        results.push(full);
      }
    } catch {
      // permission or other I/O error — skip
    }
  }

  return results;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Parse a single Codex session JSONL file into NormalizedTurns.
 */
export async function parseSession(jsonlPath: string): Promise<NormalizedTurn[]> {
  if (!existsSync(jsonlPath)) return [];

  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf-8");
  } catch {
    console.warn(`[codex-parser] unable to read ${jsonlPath}`);
    return [];
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const turns: NormalizedTurn[] = [];
  let lastTokenCount: CodexTokenCount | null = null;

  // Accumulate tool calls between token-count events so we can attach
  // them to the turn that carries the token delta.
  let pendingToolCalls: { toolName: string; filePath?: string; input?: Record<string, unknown> }[] = [];
  let pendingFiles: string[] = [];
  let sessionId = basename(jsonlPath, ".jsonl");
  let model: string | undefined;

  for (const line of lines) {
    const record = safeParseLine(line);
    if (!record) continue;

    // Capture session-level metadata when available
    if (record.session_id) sessionId = record.session_id;
    if (record.model) model = record.model;

    // Tool call events — accumulate until next token-count event
    if (
      record.type === "event_msg" &&
      record.payload?.type === "function_call"
    ) {
      const toolName: string = record.payload.name ?? record.payload.function?.name ?? "unknown";
      const input = record.payload.arguments ?? record.payload.function?.arguments;
      const parsedInput =
        typeof input === "string" ? (() => { try { return JSON.parse(input); } catch { return undefined; } })() : input;
      const filePath = extractFilePath(parsedInput as Record<string, unknown> | undefined);
      pendingToolCalls.push({ toolName, filePath, input: parsedInput as Record<string, unknown> | undefined });
      if (filePath) pendingFiles.push(filePath);
      continue;
    }

    // Token count events — emit a NormalizedTurn with computed deltas
    if (
      record.type === "event_msg" &&
      record.payload?.type === "token_count"
    ) {
      const tc: CodexTokenCount = {
        input_tokens: record.payload.input_tokens ?? 0,
        output_tokens: record.payload.output_tokens ?? 0,
        cache_read_tokens: record.payload.cache_read_tokens,
        cache_creation_tokens: record.payload.cache_creation_tokens,
        total_tokens: record.payload.total_tokens ?? 0,
      };

      const tokens = computeDelta(tc, lastTokenCount);
      lastTokenCount = tc;

      const timestamp =
        record.timestamp ?? record.payload.timestamp ?? new Date().toISOString();

      turns.push({
        timestamp,
        sessionId,
        model,
        tokens,
        toolCalls: pendingToolCalls,
        filesTouched: [...new Set(pendingFiles)],
        isSubagent: false,
      });

      // Reset accumulators
      pendingToolCalls = [];
      pendingFiles = [];
    }
  }

  return turns;
}

/**
 * Scan a Codex home directory for session files and build summaries.
 */
export async function parseAllSessions(
  codexHomeDir: string,
): Promise<SessionSummary[]> {
  const sessionsDir = join(codexHomeDir, "sessions");
  const files = findJsonlFiles(sessionsDir);
  const summaries: SessionSummary[] = [];

  for (const file of files) {
    const turns = await parseSession(file);
    if (turns.length === 0) continue;

    const sessionId = turns[0].sessionId;
    const startedAt = turns[0].timestamp;
    const endedAt = turns[turns.length - 1].timestamp;
    const startMs = new Date(startedAt).getTime();
    const endMs = new Date(endedAt).getTime();
    const durationMinutes = Math.round((endMs - startMs) / 60_000 * 100) / 100;

    const totalTokens: TokenUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total: 0,
    };
    for (const t of turns) {
      totalTokens.input += t.tokens.input;
      totalTokens.output += t.tokens.output;
      totalTokens.cacheRead += t.tokens.cacheRead;
      totalTokens.cacheCreation += t.tokens.cacheCreation;
      totalTokens.total += t.tokens.total;
    }

    summaries.push({
      sessionId,
      agent: "codex",
      startedAt,
      endedAt,
      durationMinutes,
      turns,
      totalTokens,
      model: turns.find((t) => t.model)?.model,
    });
  }

  return summaries;
}

// ── AgentParser implementation ───────────────────────────────────

const codexParser: AgentParser = {
  parseSession,

  async findSessions(baseDir: string): Promise<string[]> {
    const sessionsDir = join(baseDir, "sessions");
    return findJsonlFiles(sessionsDir);
  },
};

export { codexParser };
