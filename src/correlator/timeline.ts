import type { BuildLog, SessionSummary, TimelineEvent } from "../parsers/types.js";

export function generateTimeline(
  buildLog: BuildLog,
  sessions: SessionSummary[]
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // 1. Checklist start events
  for (const item of buildLog.checklist.items) {
    if (item.startedAt) {
      events.push({
        type: "checklist_start",
        at: item.startedAt,
        itemId: item.id,
        message: item.title,
      });
    }
  }

  // 2. Checklist done events
  for (const item of buildLog.checklist.items) {
    if (item.completedAt) {
      events.push({
        type: "checklist_done",
        at: item.completedAt,
        itemId: item.id,
        message: item.title,
        passed: item.tests.passed,
        failed: item.tests.failed,
      });
    }
  }

  // 3. Tool call events from session turns
  for (const session of sessions) {
    for (const turn of session.turns) {
      for (const tc of turn.toolCalls) {
        events.push({
          type: "tool_call",
          at: turn.timestamp,
          tool: tc.toolName,
          file: tc.filePath,
          tokens: turn.tokens.total,
          sessionId: session.sessionId,
        });
      }
    }
  }

  // 4. Session start and end events
  for (const session of sessions) {
    events.push({
      type: "session_start",
      at: session.startedAt,
      sessionId: session.sessionId,
      tokens: session.totalTokens.total,
    });
    events.push({
      type: "session_end",
      at: session.endedAt,
      sessionId: session.sessionId,
      tokens: session.totalTokens.total,
    });
  }

  // 5. Git commit events from checklist items
  for (const item of buildLog.checklist.items) {
    for (const sha of item.gitCommits) {
      events.push({
        type: "git_commit",
        at: item.completedAt ?? new Date().toISOString(),
        itemId: item.id,
        sha,
      });
    }
  }

  // Sort all events chronologically
  events.sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
  );

  return events;
}
