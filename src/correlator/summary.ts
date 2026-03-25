import type {
  BuildLog,
  BuildSummary,
  TestResults,
  ChecklistItemResult,
} from "../parsers/types.js";

/**
 * Rough per-token pricing (USD per million tokens).
 */
const PRICE_INPUT_PER_MTOK = 3.0;
const PRICE_OUTPUT_PER_MTOK = 15.0;
const PRICE_CACHE_READ_PER_MTOK = 0.3;
const PRICE_CACHE_CREATION_PER_MTOK = 3.75;

function estimateCost(item: ChecklistItemResult): number {
  if (!item.tokens) return 0;
  const { input, output, cacheRead, cacheCreation } = item.tokens;
  return (
    (input / 1_000_000) * PRICE_INPUT_PER_MTOK +
    (output / 1_000_000) * PRICE_OUTPUT_PER_MTOK +
    (cacheRead / 1_000_000) * PRICE_CACHE_READ_PER_MTOK +
    (cacheCreation / 1_000_000) * PRICE_CACHE_CREATION_PER_MTOK
  );
}

export function generateSummary(
  buildLog: BuildLog,
  testResults?: TestResults,
): BuildSummary {
  const items = buildLog.checklist.items;

  // ── Total duration: earliest startedAt → latest completedAt ──
  let earliestMs = Infinity;
  let latestMs = -Infinity;

  for (const item of items) {
    if (item.startedAt) {
      const t = new Date(item.startedAt).getTime();
      if (t < earliestMs) earliestMs = t;
    }
    if (item.completedAt) {
      const t = new Date(item.completedAt).getTime();
      if (t > latestMs) latestMs = t;
    }
  }

  const totalDurationMinutes =
    earliestMs !== Infinity && latestMs !== -Infinity
      ? (latestMs - earliestMs) / 60_000
      : 0;

  // ── Token totals ──
  let totalTokens = 0;
  let totalEstimatedCostUsd = 0;

  for (const item of items) {
    if (item.tokens) {
      totalTokens += item.tokens.total;
    }
    totalEstimatedCostUsd += estimateCost(item);
  }

  // ── Item counts ──
  const itemsCompleted = items.filter((i) => i.status === "done").length;
  const itemsTotal = items.length;

  // ── Test counts ──
  let testsCreated: number;
  let testsPassed: number;
  let testsFailed: number;

  if (testResults) {
    testsCreated = testResults.total;
    testsPassed = testResults.passed;
    testsFailed = testResults.failed;
  } else {
    testsCreated = items.reduce((sum, i) => sum + i.tests.created, 0);
    testsPassed = items.reduce((sum, i) => sum + i.tests.passed, 0);
    testsFailed = items.reduce((sum, i) => sum + i.tests.failed, 0);
  }

  // ── Files created (unique across all items) ──
  const uniqueFiles = new Set<string>();
  for (const item of items) {
    for (const f of item.filesCreated) {
      uniqueFiles.add(f);
    }
  }
  const filesCreated = uniqueFiles.size;

  // ── Architecture breakdown: group by tag ──
  const architectureBreakdown: Record<
    string,
    { tokens: number; files: number; durationMinutes: number }
  > = {};

  for (const item of items) {
    for (const tag of item.tags) {
      if (!architectureBreakdown[tag]) {
        architectureBreakdown[tag] = { tokens: 0, files: 0, durationMinutes: 0 };
      }
      const entry = architectureBreakdown[tag];
      entry.tokens += item.tokens?.total ?? 0;
      entry.files += item.filesCreated.length;
      entry.durationMinutes += item.durationMinutes ?? 0;
    }
  }

  return {
    totalDurationMinutes,
    totalTokens,
    totalEstimatedCostUsd,
    itemsCompleted,
    itemsTotal,
    testsCreated,
    testsPassed,
    testsFailed,
    filesCreated,
    architectureBreakdown,
  };
}
