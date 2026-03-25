import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestResults } from "../parsers/types.js";

// ── Framework detection ──────────────────────────────────────────

/**
 * Detect the test framework used in a project directory.
 * Checks for config files and package.json devDependencies.
 * Returns "vitest" | "jest" | "pytest" | "unknown".
 */
export function detectTestFramework(projectDir: string): string {
  // Check for vitest config files
  const vitestConfigs = [
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mts",
    "vitest.config.mjs",
  ];
  for (const cfg of vitestConfigs) {
    if (existsSync(join(projectDir, cfg))) return "vitest";
  }

  // Check for jest config files
  const jestConfigs = [
    "jest.config.ts",
    "jest.config.js",
    "jest.config.mjs",
    "jest.config.cjs",
  ];
  for (const cfg of jestConfigs) {
    if (existsSync(join(projectDir, cfg))) return "jest";
  }

  // Check for pytest markers
  const pytestConfigs = ["pytest.ini", "pyproject.toml", "setup.cfg"];
  for (const cfg of pytestConfigs) {
    if (existsSync(join(projectDir, cfg))) return "pytest";
  }

  // Fall back to package.json scripts / devDependencies
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
      const deps = (pkg.dependencies ?? {}) as Record<string, string>;
      if ("vitest" in devDeps || "vitest" in deps) return "vitest";
      if ("jest" in devDeps || "jest" in deps) return "jest";
    } catch {
      // ignore parse errors
    }
  }

  return "unknown";
}

// ── Vitest / Jest output parser ──────────────────────────────────

function parseVitestJest(stdout: string): TestResults {
  const result: TestResults = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    suites: [],
  };

  // Collect suite names — lines like " ✓ src/foo.test.ts" or "PASS src/foo.test.ts"
  const suiteRe = /(?:✓|✗|PASS|FAIL)\s+(.+\.(?:test|spec)\.\w+)/g;
  let m: RegExpExecArray | null;
  const seenSuites = new Set<string>();
  while ((m = suiteRe.exec(stdout)) !== null) {
    const name = m[1].trim();
    if (!seenSuites.has(name)) {
      seenSuites.add(name);
      result.suites.push(name);
    }
  }

  // "Tests  X passed | Y failed | Z skipped | W total" (vitest summary line)
  const vitestSummary =
    /Tests\s+(?:(\d+)\s+passed)?[| ]*(?:(\d+)\s+failed)?[| ]*(?:(\d+)\s+skipped)?[| ]*(\d+)\s+total/i;
  const vs = vitestSummary.exec(stdout);
  if (vs) {
    result.passed = parseInt(vs[1] ?? "0", 10);
    result.failed = parseInt(vs[2] ?? "0", 10);
    result.skipped = parseInt(vs[3] ?? "0", 10);
    result.total = parseInt(vs[4], 10);
  }

  // Jest-style: "Tests: X passed, Y failed, Z total"
  if (!vs) {
    const jestTests =
      /Tests:\s*(?:(\d+)\s+passed)?[, ]*(?:(\d+)\s+failed)?[, ]*(?:(\d+)\s+skipped)?[, ]*(\d+)\s+total/i;
    const jt = jestTests.exec(stdout);
    if (jt) {
      result.passed = parseInt(jt[1] ?? "0", 10);
      result.failed = parseInt(jt[2] ?? "0", 10);
      result.skipped = parseInt(jt[3] ?? "0", 10);
      result.total = parseInt(jt[4], 10);
    }
  }

  // Duration: "Duration  1.23s" or "Time: 1.234 s"
  const durationRe = /(?:Duration|Time)[:\s]+(\d+(?:\.\d+)?)\s*s/i;
  const dm = durationRe.exec(stdout);
  if (dm) {
    result.durationMs = Math.round(parseFloat(dm[1]) * 1000);
  }

  return result;
}

// ── Pytest output parser ─────────────────────────────────────────

function parsePytest(stdout: string): TestResults {
  const result: TestResults = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    suites: [],
  };

  // "X passed, Y failed, Z skipped in 1.23s"
  const summaryRe =
    /(?:(\d+)\s+passed)?[, ]*(?:(\d+)\s+failed)?[, ]*(?:(\d+)\s+skipped)?.*?in\s+(\d+(?:\.\d+)?)\s*s/i;
  const sm = summaryRe.exec(stdout);
  if (sm) {
    result.passed = parseInt(sm[1] ?? "0", 10);
    result.failed = parseInt(sm[2] ?? "0", 10);
    result.skipped = parseInt(sm[3] ?? "0", 10);
    result.total = result.passed + result.failed + result.skipped;
    result.durationMs = Math.round(parseFloat(sm[4]) * 1000);
  }

  // Collect test file names as suites: "tests/test_foo.py"
  const fileRe = /([\w/\\.-]+\.py)::/g;
  const seenSuites = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(stdout)) !== null) {
    const name = m[1];
    if (!seenSuites.has(name)) {
      seenSuites.add(name);
      result.suites.push(name);
    }
  }

  return result;
}

// ── Generic fallback parser ──────────────────────────────────────

function parseFallback(stdout: string): TestResults {
  const result: TestResults = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    suites: [],
  };

  // Try to extract passed/failed/skipped counts from any output
  const passedRe = /(\d+)\s+pass(?:ed|ing)?/i;
  const failedRe = /(\d+)\s+fail(?:ed|ing|ure)?/i;
  const skippedRe = /(\d+)\s+skip(?:ped)?/i;
  const totalRe = /(\d+)\s+(?:total|tests?)\b/i;

  const pm = passedRe.exec(stdout);
  const fm = failedRe.exec(stdout);
  const sm = skippedRe.exec(stdout);
  const tm = totalRe.exec(stdout);

  if (pm) result.passed = parseInt(pm[1], 10);
  if (fm) result.failed = parseInt(fm[1], 10);
  if (sm) result.skipped = parseInt(sm[1], 10);
  if (tm) {
    result.total = parseInt(tm[1], 10);
  } else {
    result.total = result.passed + result.failed + result.skipped;
  }

  const durationRe = /(\d+(?:\.\d+)?)\s*(?:s|seconds?)/i;
  const dm = durationRe.exec(stdout);
  if (dm) {
    result.durationMs = Math.round(parseFloat(dm[1]) * 1000);
  }

  return result;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Parse test runner stdout into a structured TestResults object.
 * @param stdout  Raw stdout from the test runner
 * @param framework  "vitest" | "jest" | "pytest" | "unknown"
 */
export function parseTestOutput(
  stdout: string,
  framework: string,
): TestResults {
  switch (framework) {
    case "vitest":
    case "jest":
      return parseVitestJest(stdout);
    case "pytest":
      return parsePytest(stdout);
    default:
      return parseFallback(stdout);
  }
}
