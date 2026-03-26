import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ParsedChecklist } from "../parsers/types.js";

export interface ReconcileMatch {
  specSection: string;
  checklistId: string;
  checklistTitle: string;
}

export interface ReconcileResult {
  uncovered: string[];
  orphaned: { id: string; title: string }[];
  matches: ReconcileMatch[];
}

/**
 * Extract ## and ### headings from a markdown spec file.
 */
export function extractSpecSections(specContent: string): string[] {
  const lines = specContent.split("\n");
  const sections: string[] = [];
  for (const line of lines) {
    const match = line.match(/^#{2,3}\s+(.+)$/);
    if (match) {
      sections.push(match[1].trim());
    }
  }
  return sections;
}

/**
 * Normalize a string for fuzzy matching: lowercase, strip punctuation, collapse whitespace.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check if two strings are a reasonable match.
 * Uses substring containment on normalized forms.
 */
function isMatch(specSection: string, checklistTitle: string): boolean {
  const normSpec = normalize(specSection);
  const normTitle = normalize(checklistTitle);
  if (normSpec === normTitle) return true;
  if (normSpec.includes(normTitle) || normTitle.includes(normSpec)) return true;

  // Check word overlap — if most words in the spec section appear in the title (or vice versa)
  const specWords = normSpec.split(" ").filter((w) => w.length > 2);
  const titleWords = normTitle.split(" ").filter((w) => w.length > 2);

  if (specWords.length === 0 || titleWords.length === 0) return false;

  const overlap = specWords.filter((w) => titleWords.includes(w));
  const overlapRatio = overlap.length / Math.min(specWords.length, titleWords.length);
  return overlapRatio >= 0.5;
}

/**
 * Reconcile a spec file against a parsed checklist.
 */
export function reconcile(
  specContent: string,
  checklist: ParsedChecklist,
): ReconcileResult {
  const specSections = extractSpecSections(specContent);
  const matches: ReconcileMatch[] = [];
  const matchedSpecSections = new Set<string>();
  const matchedChecklistIds = new Set<string>();

  for (const section of specSections) {
    for (const item of checklist.items) {
      if (isMatch(section, item.title)) {
        matches.push({
          specSection: section,
          checklistId: item.id,
          checklistTitle: item.title,
        });
        matchedSpecSections.add(section);
        matchedChecklistIds.add(item.id);
        break; // one match per spec section
      }
    }
  }

  const uncovered = specSections.filter((s) => !matchedSpecSections.has(s));
  const orphaned = checklist.items
    .filter((item) => !matchedChecklistIds.has(item.id))
    .map((item) => ({ id: item.id, title: item.title }));

  return { uncovered, orphaned, matches };
}

/**
 * Format a reconcile result as a table string.
 */
export function formatReconcileTable(result: ReconcileResult): string {
  const lines: string[] = [];

  // Matches
  lines.push("MATCHES");
  lines.push("-".repeat(80));
  if (result.matches.length === 0) {
    lines.push("  (none)");
  } else {
    const header = padRow("Spec Section", "Item ID", "Checklist Title");
    lines.push(header);
    lines.push("-".repeat(80));
    for (const m of result.matches) {
      lines.push(padRow(m.specSection, m.checklistId, m.checklistTitle));
    }
  }
  lines.push("");

  // Uncovered
  lines.push("UNCOVERED (spec sections with no checklist item)");
  lines.push("-".repeat(80));
  if (result.uncovered.length === 0) {
    lines.push("  (none)");
  } else {
    for (const s of result.uncovered) {
      lines.push(`  - ${s}`);
    }
  }
  lines.push("");

  // Orphaned
  lines.push("ORPHANED (checklist items with no spec section)");
  lines.push("-".repeat(80));
  if (result.orphaned.length === 0) {
    lines.push("  (none)");
  } else {
    for (const o of result.orphaned) {
      lines.push(`  - [${o.id}] ${o.title}`);
    }
  }

  return lines.join("\n");
}

function padRow(col1: string, col2: string, col3: string): string {
  return `  ${col1.padEnd(30)} ${col2.padEnd(10)} ${col3}`;
}

/**
 * Auto-fix: add uncovered spec sections as new checklist items to the YAML.
 */
export function fixUncovered(
  checklistPath: string,
  uncoveredSections: string[],
): number {
  if (uncoveredSections.length === 0) return 0;

  const rawYaml = readFileSync(checklistPath, "utf-8");
  const data = parseYaml(rawYaml);

  if (!data?.phases || !Array.isArray(data.phases) || data.phases.length === 0) {
    return 0;
  }

  // Find the highest existing numeric item ID to generate new ones
  let maxId = 0;
  for (const phase of data.phases) {
    if (!phase.items || !Array.isArray(phase.items)) continue;
    for (const item of phase.items) {
      const numMatch = String(item.id).match(/(\d+)\.(\d+)/);
      if (numMatch) {
        const full = parseFloat(`${numMatch[1]}.${numMatch[2]}`);
        if (full > maxId) maxId = full;
      }
    }
  }

  // Add items to the last phase
  const lastPhase = data.phases[data.phases.length - 1];
  if (!lastPhase.items) lastPhase.items = [];

  // Determine the phase number from the last phase's existing items, or use phase index
  const phaseNum = data.phases.length;
  let itemCounter = lastPhase.items.length + 1;

  for (const section of uncoveredSections) {
    lastPhase.items.push({
      id: `${phaseNum}.${itemCounter}`,
      title: section,
      tags: [],
    });
    itemCounter++;
  }

  const output = stringifyYaml(data, { lineWidth: 0 });
  writeFileSync(checklistPath, output);

  return uncoveredSections.length;
}
