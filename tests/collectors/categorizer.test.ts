import { describe, it, expect } from "vitest";
import { categorizeFile, categorizeFiles } from "../../src/collectors/categorizer.js";

describe("categorizeFile", () => {
  it("categorizes test files as 'tests'", () => {
    expect(categorizeFile("src/parsers/claude-code.test.ts")).toBe("tests");
    expect(categorizeFile("src/parsers/claude-code.spec.ts")).toBe("tests");
    expect(categorizeFile("__tests__/integration.ts")).toBe("tests");
  });

  it("categorizes MCP files as 'mcp'", () => {
    expect(categorizeFile("src/mcp/server.ts")).toBe("mcp");
    expect(categorizeFile("mcp.json")).toBe("mcp");
    expect(categorizeFile(".mcp.json")).toBe("mcp");
  });

  it("categorizes backend files as 'backend'", () => {
    expect(categorizeFile("src/api/routes.ts")).toBe("backend");
    expect(categorizeFile("src/server/app.ts")).toBe("backend");
    expect(categorizeFile("src/db/schema.ts")).toBe("backend");
    expect(categorizeFile("schema.prisma")).toBe("backend");
    expect(categorizeFile("schema.sql")).toBe("backend");
  });

  it("categorizes frontend files as 'frontend'", () => {
    expect(categorizeFile("src/components/Button.tsx")).toBe("frontend");
    expect(categorizeFile("src/pages/Home.tsx")).toBe("frontend");
    expect(categorizeFile("styles.css")).toBe("frontend");
    expect(categorizeFile("index.html")).toBe("frontend");
  });

  it("categorizes tools/scripts/hooks as 'tools'", () => {
    expect(categorizeFile("src/tools/formatter.ts")).toBe("tools");
    expect(categorizeFile("src/scripts/migrate.ts")).toBe("tools");
    expect(categorizeFile("src/hooks/useAuth.ts")).toBe("tools");
  });

  it("categorizes config files as 'config'", () => {
    expect(categorizeFile("package.json")).toBe("config");
    expect(categorizeFile("tsconfig.json")).toBe("config");
    expect(categorizeFile("settings.yaml")).toBe("config");
    expect(categorizeFile("config.yml")).toBe("config");
    expect(categorizeFile("pyproject.toml")).toBe("config");
    expect(categorizeFile(".env")).toBe("config");
  });

  it("categorizes documentation files as 'docs'", () => {
    expect(categorizeFile("README.md")).toBe("docs");
    expect(categorizeFile("docs/architecture.md")).toBe("docs");
    expect(categorizeFile("CHANGELOG.md")).toBe("docs");
  });

  it("categorizes data files as 'data'", () => {
    expect(categorizeFile("src/data/seed.ts")).toBe("data");
    expect(categorizeFile("output.csv")).toBe("data");
    expect(categorizeFile("sessions.jsonl")).toBe("data");
    expect(categorizeFile("migrations/001_init.ts")).toBe("data");
  });

  it("defaults to 'config' for unrecognized files", () => {
    expect(categorizeFile("src/index.ts")).toBe("config");
    expect(categorizeFile("src/parsers/types.ts")).toBe("config");
  });

  it("handles Windows-style backslash paths", () => {
    expect(categorizeFile("src\\components\\Button.tsx")).toBe("frontend");
    expect(categorizeFile("src\\api\\routes.ts")).toBe("backend");
  });
});

describe("categorizeFiles", () => {
  it("groups multiple file paths by their architecture tag", () => {
    const paths = [
      "src/api/routes.ts",
      "src/components/Button.tsx",
      "src/parsers/claude-code.test.ts",
      "package.json",
    ];
    const result = categorizeFiles(paths);

    expect(result["backend"]).toEqual(["src/api/routes.ts"]);
    expect(result["frontend"]).toEqual(["src/components/Button.tsx"]);
    expect(result["tests"]).toEqual(["src/parsers/claude-code.test.ts"]);
    expect(result["config"]).toEqual(["package.json"]);
  });

  it("returns an empty object for an empty array", () => {
    const result = categorizeFiles([]);
    expect(Object.keys(result)).toHaveLength(0);
  });
});
