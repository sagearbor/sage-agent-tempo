/**
 * Gemini CLI JSONL parser.
 *
 * Gemini CLI stores sessions at:
 *   ~/.gemini/tmp/<project_hash>/chats/session-*.jsonl
 *
 * JSONL record types:
 *   - session_metadata: { type, sessionId, projectHash, startTime }
 *   - user: { type, id, content: [{text}] }
 *   - gemini: { type, id, content: [{text}], ...tool_calls }
 *   - message_update: { type, id, tokens: {input, output} }
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  NormalizedTurn,
  SessionSummary,
  TokenUsage,
  AgentParser,
} from "./types.js";

interface GeminiRecord {
  type: string;
  id?: string;
  sessionId?: string;
  startTime?: string;
  content?: Array<{ text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }>;
  tokens?: { input?: number; output?: number };
  [key: string]: unknown;
}

export async function parseSession(
  jsonlPath: string
): Promise<NormalizedTurn[]> {
  if (!existsSync(jsonlPath)) return [];

  const raw = readFileSync(jsonlPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());

  let sessionId = "unknown";
  let startTime: string | undefined;
  const turns: NormalizedTurn[] = [];

  // Track cumulative tokens per message ID
  const messageTokens = new Map<string, { input: number; output: number }>();
  const messageContents = new Map<string, GeminiRecord>();

  for (const line of lines) {
    let record: GeminiRecord;
    try {
      record = JSON.parse(line);
    } catch {
      console.error(
        `[gemini parser] Skipping malformed JSONL line: ${line.slice(0, 80)}...`
      );
      continue;
    }

    switch (record.type) {
      case "session_metadata":
        sessionId = record.sessionId ?? sessionId;
        startTime = record.startTime;
        break;

      case "gemini":
        if (record.id) {
          messageContents.set(record.id, record);
        }
        break;

      case "message_update":
        if (record.id && record.tokens) {
          messageTokens.set(record.id, {
            input: record.tokens.input ?? 0,
            output: record.tokens.output ?? 0,
          });
        }
        break;
    }
  }

  // Build turns from gemini messages with their token counts
  for (const [msgId, record] of messageContents) {
    const tokens = messageTokens.get(msgId) ?? { input: 0, output: 0 };

    const toolCalls: Array<{ toolName: string; filePath?: string; input?: Record<string, unknown> }> = [];
    const filesTouched: string[] = [];

    if (record.content) {
      for (const block of record.content) {
        if (block.functionCall) {
          const tc: { toolName: string; filePath?: string; input?: Record<string, unknown> } = {
            toolName: block.functionCall.name,
          };
          if (block.functionCall.args) {
            tc.input = block.functionCall.args as Record<string, unknown>;
            const fp =
              (block.functionCall.args as Record<string, unknown>)["file_path"] ??
              (block.functionCall.args as Record<string, unknown>)["path"];
            if (typeof fp === "string") {
              tc.filePath = fp;
              filesTouched.push(fp);
            }
          }
          toolCalls.push(tc);
        }
      }
    }

    const textContent = record.content
      ?.filter((b) => b.text)
      .map((b) => b.text)
      .join("\n");

    const tokenUsage: TokenUsage = {
      input: tokens.input,
      output: tokens.output,
      cacheRead: 0,
      cacheCreation: 0,
      total: tokens.input + tokens.output,
    };

    turns.push({
      timestamp: startTime ?? new Date().toISOString(),
      sessionId,
      uuid: msgId,
      tokens: tokenUsage,
      toolCalls,
      filesTouched: [...new Set(filesTouched)],
      content: textContent,
      isSubagent: false,
    });
  }

  return turns;
}

export async function parseAllSessions(
  geminiHomeDir: string
): Promise<SessionSummary[]> {
  const tmpDir = join(geminiHomeDir, "tmp");
  if (!existsSync(tmpDir)) return [];

  const sessions: SessionSummary[] = [];
  const files = findJsonlFiles(tmpDir);

  for (const file of files) {
    const turns = await parseSession(file);
    if (turns.length === 0) continue;

    const totalTokens = aggregateTokens(turns);
    const startedAt = turns[0].timestamp;
    const endedAt = turns[turns.length - 1].timestamp;
    const durationMinutes =
      (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60000;

    sessions.push({
      sessionId: turns[0].sessionId,
      agent: "gemini" as const,
      startedAt,
      endedAt,
      durationMinutes: Math.max(0, durationMinutes),
      turns,
      totalTokens,
    });
  }

  return sessions;
}

function findJsonlFiles(dir: string): string[] {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const results: string[] = [];

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          results.push(...findJsonlFiles(full));
        } else if (entry.endsWith(".jsonl") && entry.startsWith("session-")) {
          results.push(full);
        }
      } catch {
        // skip inaccessible entries
      }
    }
  } catch {
    // dir doesn't exist or not readable
  }

  return results;
}

function aggregateTokens(turns: NormalizedTurn[]): TokenUsage {
  const result = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
  for (const turn of turns) {
    result.input += turn.tokens.input;
    result.output += turn.tokens.output;
    result.total += turn.tokens.total;
  }
  return result;
}

export const geminiParser: AgentParser = {
  parseSession,
  async findSessions(baseDir: string): Promise<string[]> {
    return findJsonlFiles(join(baseDir, "tmp"));
  },
};
