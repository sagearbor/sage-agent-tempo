import type { ArchitectureTag } from "../parsers/types.js";

interface CategoryRule {
  tag: ArchitectureTag;
  patterns: RegExp[];
}

const RULES: CategoryRule[] = [
  {
    tag: "tests",
    patterns: [
      /\.test\.\w+$/,
      /\.spec\.\w+$/,
      /(^|\/)__tests__\//,
    ],
  },
  {
    tag: "mcp",
    patterns: [
      /(^|\/)src\/mcp\//,
      /(^|\/)mcp\.json$/,
      /(^|\/)\.mcp\.json$/,
    ],
  },
  {
    tag: "backend",
    patterns: [
      /(^|\/)src\/api\//,
      /(^|\/)src\/server\//,
      /(^|\/)src\/db\//,
      /\.prisma$/,
      /\.sql$/,
    ],
  },
  {
    tag: "frontend",
    patterns: [
      /(^|\/)src\/components\//,
      /(^|\/)src\/pages\//,
      /\.css$/,
      /\.html$/,
      /(^|\/)src\/(?:components|pages)\/.+\.jsx$/,
      /(^|\/)src\/(?:components|pages)\/.+\.tsx$/,
    ],
  },
  {
    tag: "tools",
    patterns: [
      /(^|\/)src\/tools\//,
      /(^|\/)src\/scripts\//,
      /(^|\/)src\/hooks\//,
    ],
  },
  {
    tag: "config",
    patterns: [
      /^[^/]+\.json$/,
      /^[^/]+\.yaml$/,
      /^[^/]+\.yml$/,
      /\.toml$/,
      /^\.env/,
      /tsconfig/,
      /^package\.json$/,
    ],
  },
  {
    tag: "docs",
    patterns: [
      /\.md$/,
      /(^|\/)docs\//,
    ],
  },
  {
    tag: "data",
    patterns: [
      /(^|\/)src\/data\//,
      /\.csv$/,
      /\.jsonl$/,
      /(^|\/)migrations\//,
    ],
  },
];

/**
 * Categorize a single file path into an ArchitectureTag.
 * Returns the first matching tag, or "config" as a catch-all default.
 */
export function categorizeFile(filePath: string): ArchitectureTag {
  // Normalize to forward slashes
  const normalized = filePath.replace(/\\/g, "/");

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(normalized)) {
        return rule.tag;
      }
    }
  }

  // Default fallback
  return "config";
}

/**
 * Categorize an array of file paths and group them by ArchitectureTag.
 * Returns a record where keys are tags and values are arrays of matching paths.
 */
export function categorizeFiles(
  paths: string[],
): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const filePath of paths) {
    const tag = categorizeFile(filePath);
    if (!result[tag]) {
      result[tag] = [];
    }
    result[tag].push(filePath);
  }

  return result;
}
