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
