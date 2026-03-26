import { z } from "zod";

// ── Agent Event Types ──────────────────────────────────────────────

export const AgentEventTypeSchema = z.enum([
  "tool_call",
  "assistant_message",
  "user_message",
  "system",
]);
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

export const AgentEventSchema = z.object({
  type: AgentEventTypeSchema,
  timestamp: z.string().datetime(),
  sessionId: z.string(),
  content: z.string().optional(),
  toolName: z.string().optional(),
  toolInput: z.record(z.unknown()).optional(),
  filePath: z.string().optional(),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

// ── Normalized Turn (agent-agnostic) ───────────────────────────────

export const TokenUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number().default(0),
  cacheCreation: z.number().default(0),
  total: z.number(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const NormalizedTurnSchema = z.object({
  timestamp: z.string().datetime(),
  sessionId: z.string(),
  uuid: z.string().optional(),
  parentUuid: z.string().optional(),
  model: z.string().optional(),
  tokens: TokenUsageSchema,
  toolCalls: z.array(
    z.object({
      toolName: z.string(),
      filePath: z.string().optional(),
      input: z.record(z.unknown()).optional(),
    })
  ).default([]),
  filesTouched: z.array(z.string()).default([]),
  content: z.string().optional(),
  isSubagent: z.boolean().default(false),
  testResults: z
    .object({
      passed: z.number(),
      failed: z.number(),
      skipped: z.number(),
    })
    .optional(),
});
export type NormalizedTurn = z.infer<typeof NormalizedTurnSchema>;

// ── Session Summary ────────────────────────────────────────────────

export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  agent: z.enum(["claude-code", "codex", "gemini", "unknown"]),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  durationMinutes: z.number(),
  turns: z.array(NormalizedTurnSchema),
  totalTokens: TokenUsageSchema,
  model: z.string().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

// ── Agent Parser Interface ─────────────────────────────────────────

export interface AgentParser {
  parseSession(jsonlPath: string): Promise<NormalizedTurn[]>;
  findSessions(baseDir: string): Promise<string[]>;
}

// ── Build Log Schema ───────────────────────────────────────────────

export const ArchitectureTagSchema = z.enum([
  "backend",
  "frontend",
  "mcp",
  "tools",
  "tests",
  "config",
  "docs",
  "data",
]);
export type ArchitectureTag = z.infer<typeof ArchitectureTagSchema>;

export const ChecklistItemResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  phase: z.string(),
  tags: z.array(z.string()).default([]),
  status: z.enum(["done", "in_progress", "pending", "skipped"]),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMinutes: z.number().optional(),
  tokens: TokenUsageSchema.optional(),
  turns: z.number().default(0),
  toolsUsed: z.array(z.string()).default([]),
  filesCreated: z.array(z.string()).default([]),
  filesModified: z.array(z.string()).default([]),
  tests: z
    .object({
      created: z.number().default(0),
      passed: z.number().default(0),
      failed: z.number().default(0),
    })
    .default({}),
  gitCommits: z.array(z.string()).default([]),
  confidence: z.enum(["high", "medium", "low"]).default("low"),
});
export type ChecklistItemResult = z.infer<typeof ChecklistItemResultSchema>;

export const ArchitectureBreakdownEntrySchema = z.object({
  tokens: z.number(),
  files: z.number(),
  durationMinutes: z.number(),
});

export const ModelUsageEntrySchema = z.object({
  model: z.string(),
  tokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  estimatedCostUsd: z.number(),
  turns: z.number(),
});
export type ModelUsageEntry = z.infer<typeof ModelUsageEntrySchema>;

export const BuildSummarySchema = z.object({
  totalDurationMinutes: z.number(),
  totalTokens: z.number(),
  totalEstimatedCostUsd: z.number(),
  itemsCompleted: z.number(),
  itemsTotal: z.number(),
  testsCreated: z.number(),
  testsPassed: z.number(),
  testsFailed: z.number(),
  filesCreated: z.number(),
  architectureBreakdown: z.record(ArchitectureBreakdownEntrySchema).default({}),
  modelUsage: z.array(ModelUsageEntrySchema).default([]),
});
export type BuildSummary = z.infer<typeof BuildSummarySchema>;

export const TimelineEventSchema = z.object({
  type: z.enum([
    "checklist_start",
    "checklist_done",
    "tool_call",
    "test_run",
    "git_commit",
    "session_start",
    "session_end",
  ]),
  at: z.string().datetime(),
  itemId: z.string().optional(),
  tool: z.string().optional(),
  file: z.string().optional(),
  tokens: z.number().optional(),
  passed: z.number().optional(),
  failed: z.number().optional(),
  sha: z.string().optional(),
  message: z.string().optional(),
  sessionId: z.string().optional(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const BuildLogSchema = z.object({
  project: z.string(),
  agent: z.string(),
  sessionId: z.string(),
  generatedAt: z.string().datetime(),
  checklist: z.object({
    source: z.string(),
    items: z.array(ChecklistItemResultSchema),
  }),
  summary: BuildSummarySchema,
  timeline: z.array(TimelineEventSchema).default([]),
});
export type BuildLog = z.infer<typeof BuildLogSchema>;

// ── Checklist YAML Schema ──────────────────────────────────────────

export const ChecklistItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  tags: z.array(z.string()).default([]),
  priority: z.enum(["critical", "high", "medium", "low"]).optional(),
  depends_on: z.array(z.string()).default([]),
  acceptance: z.string().optional(),
  notes: z.string().optional(),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const ChecklistPhaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  items: z.array(ChecklistItemSchema),
});
export type ChecklistPhase = z.infer<typeof ChecklistPhaseSchema>;

export const ChecklistSchema = z.object({
  project: z.string(),
  description: z.string().optional(),
  agent_instructions: z.record(z.unknown()).optional(),
  phases: z.array(ChecklistPhaseSchema),
});
export type Checklist = z.infer<typeof ChecklistSchema>;

// ── Parsed Checklist (flattened) ───────────────────────────────────

export interface ParsedChecklistItem {
  id: string;
  title: string;
  phase: string;
  phaseName: string;
  tags: string[];
  priority?: string;
  dependsOn: string[];
  acceptance?: string;
  notes?: string;
}

export interface ParsedChecklist {
  project: string;
  description?: string;
  items: ParsedChecklistItem[];
}

// ── Git Types ──────────────────────────────────────────────────────

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  linesAdded: number;
  linesDeleted: number;
}

export interface GitCommit {
  sha: string;
  message: string;
  timestamp: string;
  author: string;
  filesChanged: FileChange[];
}

// ── Test Results ───────────────────────────────────────────────────

export interface TestResults {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  suites: string[];
}
