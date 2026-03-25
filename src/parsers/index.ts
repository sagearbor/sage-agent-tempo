import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { claudeCodeParser, parseProjectSessions } from "./claude-code.js";
import { codexParser, parseAllSessions } from "./codex.js";
import type { AgentParser, SessionSummary } from "./types.js";

export type DetectedAgent = "claude-code" | "codex" | "unknown";

export function detectAgent(): DetectedAgent[] {
  const agents: DetectedAgent[] = [];
  const home = homedir();

  if (existsSync(join(home, ".claude", "projects"))) {
    agents.push("claude-code");
  }
  if (existsSync(join(home, ".codex", "sessions"))) {
    agents.push("codex");
  }

  return agents.length > 0 ? agents : ["unknown"];
}

export function getParser(agent: string): AgentParser {
  switch (agent) {
    case "claude-code":
      return claudeCodeParser;
    case "codex":
      return codexParser;
    default:
      throw new Error(`Unknown agent: "${agent}". Supported: claude-code, codex`);
  }
}

export interface ParseAutoOptions {
  agent?: string;
  sessionDir?: string;
}

export async function parseAuto(
  opts: ParseAutoOptions = {}
): Promise<SessionSummary[]> {
  const agents = opts.agent ? [opts.agent] : detectAgent();
  const allSessions: SessionSummary[] = [];

  for (const agent of agents) {
    if (agent === "unknown") continue;

    if (agent === "claude-code") {
      const dir =
        opts.sessionDir || join(homedir(), ".claude", "projects");
      const sessions = await parseProjectSessions(dir);
      allSessions.push(...sessions);
    } else if (agent === "codex") {
      const dir = opts.sessionDir || join(homedir(), ".codex");
      const sessions = await parseAllSessions(dir);
      allSessions.push(...sessions);
    }
  }

  return allSessions;
}

export { claudeCodeParser } from "./claude-code.js";
export { codexParser } from "./codex.js";
export * from "./types.js";
