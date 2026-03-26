import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { BuildLog } from "../parsers/types.js";

export interface CollapseResult {
  collapsed: number;
  total: number;
  remaining: number;
  collapsedIds: string[];
}

/**
 * Collapse completed checklist items to one-line stubs.
 *
 * For each item whose status is "done" in the build log:
 *   - Keep: id, title, status (set to "done"), tags
 *   - Remove: acceptance, notes, priority, depends_on
 *
 * Non-done items are left untouched.
 */
export function collapseChecklist(
  checklistPath: string,
  buildLogPath: string,
  dryRun: boolean,
): CollapseResult {
  const rawYaml = readFileSync(checklistPath, "utf-8");
  const data = parseYaml(rawYaml);

  // Collect done item IDs from build_log.json
  const doneIds = new Set<string>();
  if (existsSync(buildLogPath)) {
    const buildLog: BuildLog = JSON.parse(readFileSync(buildLogPath, "utf-8"));
    for (const item of buildLog.checklist.items) {
      if (item.status === "done") {
        doneIds.add(item.id);
      }
    }
  }

  let totalItems = 0;
  const collapsedIds: string[] = [];

  if (data?.phases && Array.isArray(data.phases)) {
    for (const phase of data.phases) {
      if (!phase.items || !Array.isArray(phase.items)) continue;

      for (let i = 0; i < phase.items.length; i++) {
        const item = phase.items[i];
        totalItems++;

        if (doneIds.has(item.id)) {
          collapsedIds.push(item.id);

          // Build collapsed stub: keep id, title, status, tags
          const stub: Record<string, unknown> = {
            id: item.id,
            title: item.title,
            status: "done",
          };
          if (item.tags && Array.isArray(item.tags) && item.tags.length > 0) {
            stub.tags = item.tags;
          }

          phase.items[i] = stub;
        }
      }
    }
  }

  if (!dryRun && collapsedIds.length > 0) {
    const output = stringifyYaml(data, { lineWidth: 0 });
    writeFileSync(checklistPath, output);
  }

  return {
    collapsed: collapsedIds.length,
    total: totalItems,
    remaining: totalItems - collapsedIds.length,
    collapsedIds,
  };
}

export interface AutoCollapseResult {
  phasesCollapsed: string[];
  totalCollapsed: number;
}

/**
 * Automatically collapse items in phases that are 100% done.
 *
 * Reads the build log, groups items by phase, and if every item in a phase
 * has status "done", collapses that phase's items in the checklist YAML.
 */
export function autoCollapseIfNeeded(
  checklistPath: string,
  buildLogPath: string,
): AutoCollapseResult {
  if (!existsSync(buildLogPath)) {
    return { phasesCollapsed: [], totalCollapsed: 0 };
  }

  const buildLog: BuildLog = JSON.parse(readFileSync(buildLogPath, "utf-8"));

  // Group items by phase and check if all are done
  const phaseItems = new Map<string, { id: string; status: string }[]>();
  for (const item of buildLog.checklist.items) {
    if (!phaseItems.has(item.phase)) {
      phaseItems.set(item.phase, []);
    }
    phaseItems.get(item.phase)!.push({ id: item.id, status: item.status });
  }

  // Find phases where 100% of items are done
  const completedPhases = new Set<string>();
  const doneIdsInCompletedPhases = new Set<string>();

  for (const [phase, items] of phaseItems) {
    if (items.length > 0 && items.every((i) => i.status === "done")) {
      completedPhases.add(phase);
      for (const item of items) {
        doneIdsInCompletedPhases.add(item.id);
      }
    }
  }

  if (completedPhases.size === 0) {
    return { phasesCollapsed: [], totalCollapsed: 0 };
  }

  // Read and update the checklist YAML — only collapse items in completed phases
  const rawYaml = readFileSync(checklistPath, "utf-8");
  const data = parseYaml(rawYaml);
  let totalCollapsed = 0;

  if (data?.phases && Array.isArray(data.phases)) {
    for (const phase of data.phases) {
      if (!completedPhases.has(phase.id)) continue;
      if (!phase.items || !Array.isArray(phase.items)) continue;

      for (let i = 0; i < phase.items.length; i++) {
        const item = phase.items[i];
        if (doneIdsInCompletedPhases.has(item.id)) {
          // Already collapsed items (status === "done" with no extra fields) are skipped
          if (item.status === "done" && !item.acceptance && !item.notes && !item.priority && !item.depends_on) {
            continue;
          }

          const stub: Record<string, unknown> = {
            id: item.id,
            title: item.title,
            status: "done",
          };
          if (item.tags && Array.isArray(item.tags) && item.tags.length > 0) {
            stub.tags = item.tags;
          }
          phase.items[i] = stub;
          totalCollapsed++;
        }
      }
    }
  }

  if (totalCollapsed > 0) {
    const output = stringifyYaml(data, { lineWidth: 0 });
    writeFileSync(checklistPath, output);
  }

  const phasesCollapsed = [...completedPhases];
  for (const phase of phasesCollapsed) {
    console.log(`Auto-collapsed phase "${phase}" (100% complete)`);
  }

  return { phasesCollapsed, totalCollapsed };
}
