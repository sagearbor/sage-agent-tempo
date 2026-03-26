import type {
  BuildLog,
  BuildSummary,
  TestResults,
  ChecklistItemResult,
  ModelUsageEntry,
  NormalizedTurn,
} from "../parsers/types.js";
import type { ModelPricing } from "../utils/pricing.js";

/**
 * Rough per-token pricing (USD per million tokens) — hardcoded fallback.
 */
const PRICE_INPUT_PER_MTOK = 3.0;
const PRICE_OUTPUT_PER_MTOK = 15.0;
const PRICE_CACHE_READ_PER_MTOK = 0.3;
const PRICE_CACHE_CREATION_PER_MTOK = 3.75;

function estimateCostFallback(item: ChecklistItemResult): number {
  if (!item.tokens) return 0;
  const { input, output, cacheRead, cacheCreation } = item.tokens;
  return (
    (input / 1_000_000) * PRICE_INPUT_PER_MTOK +
    (output / 1_000_000) * PRICE_OUTPUT_PER_MTOK +
    (cacheRead / 1_000_000) * PRICE_CACHE_READ_PER_MTOK +
    (cacheCreation / 1_000_000) * PRICE_CACHE_CREATION_PER_MTOK
  );
}

function estimateCostWithPricing(
  item: ChecklistItemResult,
  pricingMap: Map<string, ModelPricing>,
): number {
  if (!item.tokens) return 0;
  // If we have per-model pricing from the correlator, use the first model's pricing
  // For item-level costs we use the default pricing since items aggregate across models
  const defaultPricing = pricingMap.values().next().value;
  if (!defaultPricing) return estimateCostFallback(item);
  const { input, output, cacheRead, cacheCreation } = item.tokens;
  return (
    input * defaultPricing.inputCostPerToken +
    output * defaultPricing.outputCostPerToken +
    cacheRead * defaultPricing.cacheReadCostPerToken +
    cacheCreation * defaultPricing.cacheCreationCostPerToken
  );
}

export interface SummaryOptions {
  testResults?: TestResults;
  pricingMap?: Map<string, ModelPricing>;
  turns?: NormalizedTurn[];
}

export function generateSummary(
  buildLog: BuildLog,
  testResultsOrOpts?: TestResults | SummaryOptions,
  pricingMap?: Map<string, ModelPricing>,
): BuildSummary {
  // Support both old signature (testResults, pricingMap) and new options object
  let testResults: TestResults | undefined;
  let turns: NormalizedTurn[] | undefined;

  if (testResultsOrOpts && "turns" in testResultsOrOpts) {
    // New options object form
    testResults = testResultsOrOpts.testResults;
    pricingMap = testResultsOrOpts.pricingMap ?? pricingMap;
    turns = testResultsOrOpts.turns;
  } else {
    testResults = testResultsOrOpts as TestResults | undefined;
  }
  const items = buildLog.checklist.items;

  // ── Total duration: earliest startedAt → latest completedAt across ALL items ──
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

  let totalDurationMinutes =
    earliestMs !== Infinity && latestMs !== -Infinity
      ? (latestMs - earliestMs) / 60_000
      : 0;

  // Sanity check: if duration exceeds 48 hours, timestamps are likely corrupt
  const MAX_DURATION_MINUTES = 48 * 60;
  if (totalDurationMinutes > MAX_DURATION_MINUTES) {
    console.warn(
      `Duration ${Math.round(totalDurationMinutes)}m exceeds 48h — timestamps may be corrupt. Clamping to 48h.`,
    );
    totalDurationMinutes = MAX_DURATION_MINUTES;
  }

  // ── Token totals ──
  let totalTokens = 0;
  let totalEstimatedCostUsd = 0;

  for (const item of items) {
    if (item.tokens) {
      totalTokens += item.tokens.total;
    }
    totalEstimatedCostUsd += pricingMap
      ? estimateCostWithPricing(item, pricingMap)
      : estimateCostFallback(item);
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

  // ── Model usage breakdown ──
  const modelUsage = aggregateModelUsage(turns ?? [], pricingMap);

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
    modelUsage,
  };
}

function aggregateModelUsage(
  turns: NormalizedTurn[],
  pricingMap?: Map<string, ModelPricing>,
): ModelUsageEntry[] {
  const byModel = new Map<
    string,
    { input: number; output: number; cacheRead: number; cacheCreation: number; total: number; turns: number }
  >();

  for (const turn of turns) {
    const model = turn.model ?? "unknown";
    let entry = byModel.get(model);
    if (!entry) {
      entry = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, turns: 0 };
      byModel.set(model, entry);
    }
    entry.input += turn.tokens.input;
    entry.output += turn.tokens.output;
    entry.cacheRead += turn.tokens.cacheRead;
    entry.cacheCreation += turn.tokens.cacheCreation;
    entry.total += turn.tokens.total;
    entry.turns += 1;
  }

  const results: ModelUsageEntry[] = [];
  for (const [model, entry] of byModel) {
    const pricing = pricingMap?.get(model);
    let estimatedCostUsd: number;
    if (pricing) {
      estimatedCostUsd =
        entry.input * pricing.inputCostPerToken +
        entry.output * pricing.outputCostPerToken +
        entry.cacheRead * pricing.cacheReadCostPerToken +
        entry.cacheCreation * pricing.cacheCreationCostPerToken;
    } else {
      estimatedCostUsd =
        (entry.input / 1_000_000) * PRICE_INPUT_PER_MTOK +
        (entry.output / 1_000_000) * PRICE_OUTPUT_PER_MTOK +
        (entry.cacheRead / 1_000_000) * PRICE_CACHE_READ_PER_MTOK +
        (entry.cacheCreation / 1_000_000) * PRICE_CACHE_CREATION_PER_MTOK;
    }

    results.push({
      model,
      tokens: entry.total,
      inputTokens: entry.input,
      outputTokens: entry.output,
      cacheReadTokens: entry.cacheRead,
      cacheCreationTokens: entry.cacheCreation,
      estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
      turns: entry.turns,
    });
  }

  // Sort by total tokens descending
  results.sort((a, b) => b.tokens - a.tokens);
  return results;
}
