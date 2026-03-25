import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  ChecklistSchema,
  type Checklist,
  type ParsedChecklist,
  type ParsedChecklistItem,
} from "../parsers/types.js";

export function parseChecklist(yamlPath: string): ParsedChecklist {
  const raw = readFileSync(yamlPath, "utf-8");
  const data = parseYaml(raw);
  return validateAndFlatten(data);
}

export function validateChecklist(data: unknown): Checklist {
  return ChecklistSchema.parse(data);
}

function validateAndFlatten(data: unknown): ParsedChecklist {
  const checklist = validateChecklist(data);

  const items: ParsedChecklistItem[] = [];
  const allIds = new Set<string>();

  for (const phase of checklist.phases) {
    for (const item of phase.items) {
      if (allIds.has(item.id)) {
        throw new Error(`Duplicate checklist item ID: "${item.id}"`);
      }
      allIds.add(item.id);
    }
  }

  for (const phase of checklist.phases) {
    for (const item of phase.items) {
      for (const dep of item.depends_on) {
        if (!allIds.has(dep)) {
          throw new Error(
            `Item "${item.id}" depends on unknown item "${dep}"`
          );
        }
      }

      items.push({
        id: item.id,
        title: item.title,
        phase: phase.id,
        phaseName: phase.name,
        tags: item.tags,
        priority: item.priority,
        dependsOn: item.depends_on,
        acceptance: item.acceptance,
        notes: item.notes,
      });
    }
  }

  detectCircularDeps(items);

  return {
    project: checklist.project,
    description: checklist.description,
    items,
  };
}

function detectCircularDeps(items: ParsedChecklistItem[]): void {
  const itemMap = new Map(items.map((i) => [i.id, i]));
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(id: string, path: string[]): void {
    if (inStack.has(id)) {
      const cycle = [...path.slice(path.indexOf(id)), id];
      throw new Error(`Circular dependency detected: ${cycle.join(" → ")}`);
    }
    if (visited.has(id)) return;

    inStack.add(id);
    path.push(id);

    const item = itemMap.get(id);
    if (item) {
      for (const dep of item.dependsOn) {
        dfs(dep, [...path]);
      }
    }

    inStack.delete(id);
    visited.add(id);
  }

  for (const item of items) {
    dfs(item.id, []);
  }
}
