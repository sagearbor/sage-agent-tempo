import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseChecklist, validateChecklist } from "../../src/collectors/checklist.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const validFixture = join(__dirname, "../fixtures/sample-checklist.yaml");
const invalidFixture = join(__dirname, "../fixtures/invalid-checklist.yaml");

describe("parseChecklist", () => {
  it("parses a valid checklist YAML file", () => {
    const result = parseChecklist(validFixture);
    expect(result.project).toBe("test-project");
    expect(result.description).toBe("A sample checklist for testing");
    expect(result.items).toHaveLength(4);
  });

  it("flattens phases into items with phase metadata", () => {
    const result = parseChecklist(validFixture);

    const setupItems = result.items.filter((i) => i.phase === "phase-1");
    expect(setupItems).toHaveLength(2);
    expect(setupItems[0].phaseName).toBe("Setup");

    const implItems = result.items.filter((i) => i.phase === "phase-2");
    expect(implItems).toHaveLength(2);
    expect(implItems[0].phaseName).toBe("Implementation");
  });

  it("preserves tags, priority, and dependsOn", () => {
    const result = parseChecklist(validFixture);

    const ciItem = result.items.find((i) => i.id === "setup-ci");
    expect(ciItem).toBeDefined();
    expect(ciItem!.tags).toEqual(["config", "tools"]);
    expect(ciItem!.priority).toBe("high");
    expect(ciItem!.dependsOn).toEqual(["setup-repo"]);
  });

  it("preserves acceptance criteria", () => {
    const result = parseChecklist(validFixture);
    const repoItem = result.items.find((i) => i.id === "setup-repo");
    expect(repoItem!.acceptance).toBe("Repository is initialized with correct structure");
  });
});

describe("validateChecklist", () => {
  it("throws on missing project field", () => {
    expect(() => parseChecklist(invalidFixture)).toThrow();
  });

  it("validates a well-formed data object", () => {
    const valid = {
      project: "my-project",
      phases: [
        {
          id: "p1",
          name: "Phase 1",
          items: [{ id: "item-1", title: "Do something" }],
        },
      ],
    };
    const result = validateChecklist(valid);
    expect(result.project).toBe("my-project");
    expect(result.phases).toHaveLength(1);
  });

  it("detects duplicate item IDs", () => {
    const dupeFixture = {
      project: "dupe-test",
      phases: [
        {
          id: "p1",
          name: "Phase 1",
          items: [
            { id: "same-id", title: "First item" },
            { id: "same-id", title: "Duplicate item" },
          ],
        },
      ],
    };

    // validateChecklist alone won't catch duplicates — parseChecklist's
    // internal validateAndFlatten does. We simulate via validateChecklist + manual check.
    // Actually, the duplicate detection is in validateAndFlatten which is called by parseChecklist.
    // We need to test it through the YAML path or build a temp file.
    // Instead, let's use the writeFileSync approach:
    const { writeFileSync, unlinkSync } = require("node:fs");
    const { join: pathJoin } = require("node:path");
    const tmpPath = pathJoin(__dirname, "../fixtures/dupe-checklist.yaml");
    const { stringify } = require("yaml");
    writeFileSync(tmpPath, stringify(dupeFixture));
    try {
      expect(() => parseChecklist(tmpPath)).toThrow(/Duplicate checklist item ID/);
    } finally {
      unlinkSync(tmpPath);
    }
  });

  it("detects missing dependency references", () => {
    const missingDepFixture = {
      project: "dep-test",
      phases: [
        {
          id: "p1",
          name: "Phase 1",
          items: [
            {
              id: "item-1",
              title: "Has missing dep",
              depends_on: ["nonexistent-item"],
            },
          ],
        },
      ],
    };

    const { writeFileSync, unlinkSync } = require("node:fs");
    const { join: pathJoin } = require("node:path");
    const tmpPath = pathJoin(__dirname, "../fixtures/missing-dep-checklist.yaml");
    const { stringify } = require("yaml");
    writeFileSync(tmpPath, stringify(missingDepFixture));
    try {
      expect(() => parseChecklist(tmpPath)).toThrow(/depends on unknown item/);
    } finally {
      unlinkSync(tmpPath);
    }
  });
});
