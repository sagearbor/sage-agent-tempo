import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import {
  extractSpecSections,
  reconcile,
  formatReconcileTable,
  fixUncovered,
} from "../../src/commands/reconcile.js";
import type { ParsedChecklist } from "../../src/parsers/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, "../fixtures");

const sampleSpec = `# My Project

## Authentication
Set up auth for the app.

### OAuth Integration
Handle OAuth flows.

## Data Pipeline
Build the data pipeline.

### ETL Processing
Extract, transform, load.

## Deployment
Deploy to production.
`;

const sampleChecklist: ParsedChecklist = {
  project: "test-project",
  items: [
    {
      id: "1.1",
      title: "Authentication setup",
      phase: "phase-1",
      phaseName: "Setup",
      tags: ["backend"],
      dependsOn: [],
    },
    {
      id: "1.2",
      title: "OAuth Integration",
      phase: "phase-1",
      phaseName: "Setup",
      tags: ["backend"],
      dependsOn: [],
    },
    {
      id: "2.1",
      title: "Build data pipeline",
      phase: "phase-2",
      phaseName: "Core",
      tags: ["data"],
      dependsOn: [],
    },
    {
      id: "3.1",
      title: "Write unit tests",
      phase: "phase-3",
      phaseName: "Testing",
      tags: ["tests"],
      dependsOn: [],
    },
  ],
};

describe("extractSpecSections", () => {
  it("extracts ## and ### headings", () => {
    const sections = extractSpecSections(sampleSpec);
    expect(sections).toEqual([
      "Authentication",
      "OAuth Integration",
      "Data Pipeline",
      "ETL Processing",
      "Deployment",
    ]);
  });

  it("ignores # (h1) headings", () => {
    const sections = extractSpecSections("# Top Level\n## Second Level\n");
    expect(sections).toEqual(["Second Level"]);
  });

  it("returns empty array for no headings", () => {
    const sections = extractSpecSections("Just some text\nwith no headings\n");
    expect(sections).toEqual([]);
  });
});

describe("reconcile", () => {
  it("finds matching pairs between spec and checklist", () => {
    const result = reconcile(sampleSpec, sampleChecklist);
    // "Authentication" matches "Authentication setup"
    // "OAuth Integration" matches "OAuth Integration"
    // "Data Pipeline" matches "Build data pipeline"
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
  });

  it("finds uncovered spec sections", () => {
    const result = reconcile(sampleSpec, sampleChecklist);
    // "ETL Processing" and "Deployment" have no matching checklist items
    expect(result.uncovered).toContain("ETL Processing");
    expect(result.uncovered).toContain("Deployment");
  });

  it("finds orphaned checklist items", () => {
    const result = reconcile(sampleSpec, sampleChecklist);
    // "Write unit tests" has no matching spec section
    const orphanedIds = result.orphaned.map((o) => o.id);
    expect(orphanedIds).toContain("3.1");
  });

  it("handles empty spec", () => {
    const result = reconcile("", sampleChecklist);
    expect(result.matches).toEqual([]);
    expect(result.uncovered).toEqual([]);
    expect(result.orphaned.length).toBe(sampleChecklist.items.length);
  });

  it("handles empty checklist", () => {
    const emptyChecklist: ParsedChecklist = { project: "empty", items: [] };
    const result = reconcile(sampleSpec, emptyChecklist);
    expect(result.matches).toEqual([]);
    expect(result.uncovered.length).toBe(5); // all spec sections uncovered
    expect(result.orphaned).toEqual([]);
  });
});

describe("formatReconcileTable", () => {
  it("produces formatted output with all sections", () => {
    const result = reconcile(sampleSpec, sampleChecklist);
    const table = formatReconcileTable(result);
    expect(table).toContain("MATCHES");
    expect(table).toContain("UNCOVERED");
    expect(table).toContain("ORPHANED");
  });

  it("handles empty result", () => {
    const table = formatReconcileTable({
      matches: [],
      uncovered: [],
      orphaned: [],
    });
    expect(table).toContain("(none)");
  });
});

describe("fixUncovered", () => {
  const checklistPath = join(fixturesDir, "reconcile-test-checklist.yaml");

  const sampleChecklistYaml = {
    project: "test-project",
    phases: [
      {
        id: "phase-1",
        name: "Setup",
        items: [
          { id: "1.1", title: "Initialize project", tags: ["config"] },
        ],
      },
    ],
  };

  beforeEach(() => {
    writeFileSync(checklistPath, stringifyYaml(sampleChecklistYaml));
  });

  afterEach(() => {
    if (existsSync(checklistPath)) unlinkSync(checklistPath);
  });

  it("adds uncovered sections as new items to last phase", () => {
    const added = fixUncovered(checklistPath, ["Deployment", "Monitoring"]);
    expect(added).toBe(2);

    const updated = parseYaml(readFileSync(checklistPath, "utf-8"));
    const lastPhase = updated.phases[updated.phases.length - 1];
    const titles = lastPhase.items.map((i: { title: string }) => i.title);
    expect(titles).toContain("Deployment");
    expect(titles).toContain("Monitoring");
  });

  it("returns 0 for empty uncovered list", () => {
    const added = fixUncovered(checklistPath, []);
    expect(added).toBe(0);
  });

  it("assigns sequential IDs to new items", () => {
    fixUncovered(checklistPath, ["New Feature"]);

    const updated = parseYaml(readFileSync(checklistPath, "utf-8"));
    const lastPhase = updated.phases[updated.phases.length - 1];
    const newItem = lastPhase.items.find(
      (i: { title: string }) => i.title === "New Feature",
    );
    expect(newItem).toBeDefined();
    expect(newItem.id).toBeTruthy();
  });
});
