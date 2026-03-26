import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { NormalizedTurn } from "../parsers/types.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface ModelPricing {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheCreationCostPerToken: number;
  cacheReadCostPerToken: number;
}

/** Raw shape from LiteLLM's JSON for a single model entry. */
interface LiteLLMModelEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  [key: string]: unknown;
}

// ── Constants ─────────────────────────────────────────────────────────

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const CACHE_DIR = join(homedir(), ".cache", "sage-agent-tempo");
const CACHE_FILE = join(CACHE_DIR, "pricing.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Hardcoded fallback pricing (USD per token) for common models.
 * Used when the LiteLLM fetch fails entirely.
 */
const FALLBACK_PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-4-20250514": {
    inputCostPerToken: 3.0 / 1_000_000,
    outputCostPerToken: 15.0 / 1_000_000,
    cacheCreationCostPerToken: 3.75 / 1_000_000,
    cacheReadCostPerToken: 0.3 / 1_000_000,
  },
  "claude-opus-4-20250514": {
    inputCostPerToken: 15.0 / 1_000_000,
    outputCostPerToken: 75.0 / 1_000_000,
    cacheCreationCostPerToken: 18.75 / 1_000_000,
    cacheReadCostPerToken: 1.5 / 1_000_000,
  },
  "claude-haiku-3-5-20241022": {
    inputCostPerToken: 0.8 / 1_000_000,
    outputCostPerToken: 4.0 / 1_000_000,
    cacheCreationCostPerToken: 1.0 / 1_000_000,
    cacheReadCostPerToken: 0.08 / 1_000_000,
  },
};

/** The generic default when no model match is found at all. */
const DEFAULT_PRICING: ModelPricing = {
  inputCostPerToken: 3.0 / 1_000_000,
  outputCostPerToken: 15.0 / 1_000_000,
  cacheCreationCostPerToken: 3.75 / 1_000_000,
  cacheReadCostPerToken: 0.3 / 1_000_000,
};

// ── Internal helpers ──────────────────────────────────────────────────

/** In-memory cache so we only read disk / fetch once per process. */
let memoryCache: Record<string, LiteLLMModelEntry> | null = null;

function isCacheFresh(): boolean {
  try {
    if (!existsSync(CACHE_FILE)) return false;
    const stat = statSync(CACHE_FILE);
    return Date.now() - stat.mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

function readDiskCache(): Record<string, LiteLLMModelEntry> | null {
  try {
    const raw = readFileSync(CACHE_FILE, "utf-8");
    return JSON.parse(raw) as Record<string, LiteLLMModelEntry>;
  } catch {
    return null;
  }
}

function writeDiskCache(data: Record<string, LiteLLMModelEntry>): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(data), "utf-8");
  } catch {
    // Non-fatal — we still have the in-memory copy.
  }
}

async function fetchLiteLLMPricing(): Promise<Record<string, LiteLLMModelEntry> | null> {
  try {
    const res = await fetch(LITELLM_URL);
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, LiteLLMModelEntry>;
    return data;
  } catch {
    return null;
  }
}

/**
 * Load the full pricing dictionary, using cache layers:
 * memory -> disk (if fresh) -> network -> null.
 */
async function loadPricingData(): Promise<Record<string, LiteLLMModelEntry> | null> {
  if (memoryCache) return memoryCache;

  if (isCacheFresh()) {
    const disk = readDiskCache();
    if (disk) {
      memoryCache = disk;
      return disk;
    }
  }

  const remote = await fetchLiteLLMPricing();
  if (remote) {
    memoryCache = remote;
    writeDiskCache(remote);
    return remote;
  }

  // Last resort: try stale disk cache
  const stale = readDiskCache();
  if (stale) {
    memoryCache = stale;
    return stale;
  }

  return null;
}

/**
 * Map a model name from session files to possible LiteLLM keys.
 * LiteLLM uses keys like "claude-sonnet-4-20250514" or "anthropic/claude-sonnet-4-20250514".
 */
function modelNameCandidates(modelName: string): string[] {
  const base = modelName.replace(/^anthropic\//, "");
  return [
    base,
    `anthropic/${base}`,
    // Try without date suffix: "claude-sonnet-4-20250514" -> "claude-sonnet-4"
    base.replace(/-\d{8}$/, ""),
    `anthropic/${base.replace(/-\d{8}$/, "")}`,
  ];
}

function entryToPricing(entry: LiteLLMModelEntry): ModelPricing {
  return {
    inputCostPerToken: entry.input_cost_per_token ?? DEFAULT_PRICING.inputCostPerToken,
    outputCostPerToken: entry.output_cost_per_token ?? DEFAULT_PRICING.outputCostPerToken,
    cacheCreationCostPerToken:
      entry.cache_creation_input_token_cost ?? DEFAULT_PRICING.cacheCreationCostPerToken,
    cacheReadCostPerToken:
      entry.cache_read_input_token_cost ?? DEFAULT_PRICING.cacheReadCostPerToken,
  };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Get per-token pricing for a specific model.
 * Fetches from LiteLLM (with 24h cache) and falls back to hardcoded defaults.
 */
export async function getModelPricing(modelName: string): Promise<ModelPricing> {
  const data = await loadPricingData();

  if (data) {
    for (const candidate of modelNameCandidates(modelName)) {
      const entry = data[candidate];
      if (entry) return entryToPricing(entry);
    }
  }

  // Fallback to hardcoded pricing
  const base = modelName.replace(/^anthropic\//, "");
  if (FALLBACK_PRICING[base]) return FALLBACK_PRICING[base];

  return DEFAULT_PRICING;
}

/**
 * Estimate USD cost for a single normalized turn using per-model pricing.
 */
export async function estimateCostForTurn(turn: NormalizedTurn): Promise<number> {
  const model = turn.model ?? "unknown";
  const pricing = await getModelPricing(model);
  const { input, output, cacheRead, cacheCreation } = turn.tokens;

  return (
    input * pricing.inputCostPerToken +
    output * pricing.outputCostPerToken +
    cacheRead * pricing.cacheReadCostPerToken +
    cacheCreation * pricing.cacheCreationCostPerToken
  );
}

/**
 * Reset the in-memory cache (useful for testing).
 */
export function _resetCache(): void {
  memoryCache = null;
}
