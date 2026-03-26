import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { parseSession } from "../../src/parsers/claude-code.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturePath = join(__dirname, "../fixtures/claude-code/simple-session.jsonl");
const testResultsFixturePath = join(__dirname, "../fixtures/claude-code/session-with-tests.jsonl");

describe("claude-code parseSession", () => {
  it("extracts the correct number of assistant turns", async () => {
    const turns = await parseSession(fixturePath);
    expect(turns).toHaveLength(5);
  });

  it("populates token counts for each turn", async () => {
    const turns = await parseSession(fixturePath);

    // First turn: input=1500, output=800, cacheCreation=100, cacheRead=200
    expect(turns[0].tokens.input).toBe(1500);
    expect(turns[0].tokens.output).toBe(800);
    expect(turns[0].tokens.cacheCreation).toBe(100);
    expect(turns[0].tokens.cacheRead).toBe(200);
    expect(turns[0].tokens.total).toBe(1500 + 800 + 100 + 200);

    // Verify all turns have non-zero totals
    for (const turn of turns) {
      expect(turn.tokens.total).toBeGreaterThan(0);
    }
  });

  it("extracts tool calls with correct tool names", async () => {
    const turns = await parseSession(fixturePath);

    // Turn 1: Bash
    expect(turns[0].toolCalls).toHaveLength(1);
    expect(turns[0].toolCalls[0].toolName).toBe("Bash");

    // Turn 2: Write
    expect(turns[1].toolCalls).toHaveLength(1);
    expect(turns[1].toolCalls[0].toolName).toBe("Write");
    expect(turns[1].toolCalls[0].filePath).toBe("src/index.ts");

    // Turn 3: Read
    expect(turns[2].toolCalls).toHaveLength(1);
    expect(turns[2].toolCalls[0].toolName).toBe("Read");
    expect(turns[2].toolCalls[0].filePath).toBe("tsconfig.json");

    // Turn 4: Write + Bash (2 tool calls)
    expect(turns[3].toolCalls).toHaveLength(2);
    expect(turns[3].toolCalls[0].toolName).toBe("Write");
    expect(turns[3].toolCalls[1].toolName).toBe("Bash");

    // Turn 5: Bash
    expect(turns[4].toolCalls).toHaveLength(1);
    expect(turns[4].toolCalls[0].toolName).toBe("Bash");
  });

  it("extracts filesTouched from tool call inputs", async () => {
    const turns = await parseSession(fixturePath);

    expect(turns[1].filesTouched).toContain("src/index.ts");
    expect(turns[2].filesTouched).toContain("tsconfig.json");
    expect(turns[3].filesTouched).toContain("src/utils.ts");
  });

  it("sets the model field on each turn", async () => {
    const turns = await parseSession(fixturePath);
    for (const turn of turns) {
      expect(turn.model).toBe("claude-sonnet-4-20250514");
    }
  });

  it("sets sessionId and uuid on each turn", async () => {
    const turns = await parseSession(fixturePath);
    for (let i = 0; i < turns.length; i++) {
      expect(turns[i].sessionId).toBe("test-session-1");
      expect(turns[i].uuid).toBe(`uuid-${i + 1}`);
    }
  });

  it("skips malformed JSONL lines gracefully", async () => {
    const malformedFixture = join(__dirname, "../fixtures/claude-code/malformed-session.jsonl");
    const content = [
      '{"type":"assistant","timestamp":"2026-03-25T10:00:05.000Z","sessionId":"test-session-1","uuid":"uuid-m1","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}],"usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"model":"claude-sonnet-4-20250514"}}',
      'THIS IS NOT VALID JSON',
      '{"type":"assistant","timestamp":"2026-03-25T10:00:10.000Z","sessionId":"test-session-1","uuid":"uuid-m2","message":{"role":"assistant","content":[{"type":"text","text":"World"}],"usage":{"input_tokens":200,"output_tokens":100,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"model":"claude-sonnet-4-20250514"}}',
    ].join("\n");

    writeFileSync(malformedFixture, content);
    try {
      const turns = await parseSession(malformedFixture);
      // Should get 2 valid turns, skipping the malformed line
      expect(turns).toHaveLength(2);
      expect(turns[0].uuid).toBe("uuid-m1");
      expect(turns[1].uuid).toBe("uuid-m2");
    } finally {
      unlinkSync(malformedFixture);
    }
  });

  it("skips user messages and only returns assistant turns", async () => {
    const turns = await parseSession(fixturePath);
    // The fixture has 5 user messages and 5 assistant messages
    // parseSession should only return assistant turns
    expect(turns).toHaveLength(5);
  });

  it("extracts test results from tool_result blocks", async () => {
    const turns = await parseSession(testResultsFixturePath);

    // Turn 1 (uuid-t1) ran vitest and the tool_result follows with test output
    // 8 passed, 1 failed, 2 skipped
    expect(turns[0].testResults).toBeDefined();
    expect(turns[0].testResults!.passed).toBe(8);
    expect(turns[0].testResults!.failed).toBe(1);
    expect(turns[0].testResults!.skipped).toBe(2);

    // Turn 2 (uuid-t2) is a Write call — no test results
    expect(turns[1].testResults).toBeUndefined();

    // Turn 3 (uuid-t3) ran vitest again — 11 passed, 0 failed, 0 skipped
    expect(turns[2].testResults).toBeDefined();
    expect(turns[2].testResults!.passed).toBe(11);
    expect(turns[2].testResults!.failed).toBe(0);
    expect(turns[2].testResults!.skipped).toBe(0);

    // Turn 4 (uuid-t4) is just text — no test results
    expect(turns[3].testResults).toBeUndefined();
  });

  it("does not attach test results to turns without test output", async () => {
    const turns = await parseSession(fixturePath);
    // The simple fixture has no tool_result blocks with test output
    for (const turn of turns) {
      expect(turn.testResults).toBeUndefined();
    }
  });

  it("deduplicates turns by uuid", async () => {
    const dupeFixture = join(__dirname, "../fixtures/claude-code/dupe-session.jsonl");
    const line = '{"type":"assistant","timestamp":"2026-03-25T10:00:05.000Z","sessionId":"test-session-1","uuid":"uuid-dup","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}],"usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"model":"claude-sonnet-4-20250514"}}';
    writeFileSync(dupeFixture, `${line}\n${line}\n`);
    try {
      const turns = await parseSession(dupeFixture);
      expect(turns).toHaveLength(1);
    } finally {
      unlinkSync(dupeFixture);
    }
  });
});
