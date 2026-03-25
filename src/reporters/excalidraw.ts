import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BuildLog,
  ChecklistItemResult,
  ArchitectureTag,
} from "../parsers/types.js";

// ── Excalidraw JSON helpers ──────────────────────────────────────

interface ExcalidrawElement {
  id: string;
  type: "rectangle" | "text" | "arrow" | "line";
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: "solid" | "hachure" | "cross-hatch";
  strokeWidth: number;
  roughness: number;
  opacity: number;
  groupIds: string[];
  boundElements: { id: string; type: "text" | "arrow" }[] | null;
  seed: number;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  locked: boolean;
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle";
  containerId?: string | null;
  originalText?: string;
  points?: [number, number][];
  startBinding?: { elementId: string; focus: number; gap: number } | null;
  endBinding?: { elementId: string; focus: number; gap: number } | null;
}

interface ExcalidrawFile {
  type: "excalidraw";
  version: 2;
  source: "sage-agent-tempo";
  elements: ExcalidrawElement[];
  appState: { gridSize: null; viewBackgroundColor: string };
  files: Record<string, never>;
}

function makeBase(
  overrides: Partial<ExcalidrawElement> & Pick<ExcalidrawElement, "type" | "x" | "y" | "width" | "height">,
): ExcalidrawElement {
  return {
    id: randomUUID(),
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    roughness: 1,
    opacity: 100,
    groupIds: [],
    boundElements: null,
    seed: Math.floor(Math.random() * 2_000_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2_000_000_000),
    isDeleted: false,
    locked: false,
    ...overrides,
  };
}

function makeRect(
  x: number,
  y: number,
  w: number,
  h: number,
  bg: string,
  groupIds: string[] = [],
): ExcalidrawElement {
  return makeBase({
    type: "rectangle",
    x,
    y,
    width: w,
    height: h,
    backgroundColor: bg,
    groupIds,
  });
}

function makeText(
  x: number,
  y: number,
  text: string,
  fontSize: number = 16,
  opts: Partial<ExcalidrawElement> = {},
): ExcalidrawElement {
  const lines = text.split("\n");
  const width = Math.max(...lines.map((l) => l.length)) * fontSize * 0.6;
  const height = lines.length * fontSize * 1.4;
  return makeBase({
    type: "text",
    x,
    y,
    width,
    height,
    text,
    originalText: text,
    fontSize,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "top",
    containerId: null,
    ...opts,
  });
}

function wrapFile(elements: ExcalidrawElement[]): ExcalidrawFile {
  return {
    type: "excalidraw",
    version: 2,
    source: "sage-agent-tempo",
    elements,
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

// ── Color palette for architecture tags ──────────────────────────

const TAG_COLORS: Record<string, string> = {
  backend: "#a8d8ea",
  frontend: "#aa96da",
  mcp: "#fcbad3",
  tools: "#ffffd2",
  tests: "#a8e6cf",
  config: "#dcedc1",
  docs: "#ffd3b6",
  data: "#ffaaa5",
};

// ── Architecture Diagram ─────────────────────────────────────────

/**
 * Generate an Excalidraw JSON object showing architecture category boxes
 * sized proportionally to token usage, arranged in a grid.
 */
export function generateArchitectureDiagram(buildLog: BuildLog): object {
  const breakdown = buildLog.summary.architectureBreakdown;
  const tags = Object.keys(breakdown);

  if (tags.length === 0) {
    return wrapFile([
      makeText(40, 40, "No architecture data available", 20),
    ]);
  }

  const maxTokens = Math.max(...tags.map((t) => breakdown[t].tokens));
  const elements: ExcalidrawElement[] = [];

  // Title
  elements.push(
    makeText(40, 20, `${buildLog.project} — Architecture Breakdown`, 24),
  );

  // Grid layout: up to 4 columns
  const cols = Math.min(tags.length, 4);
  const cellPadding = 20;
  const minBoxSize = 100;
  const maxBoxSize = 260;
  const startY = 80;
  const startX = 40;

  tags.forEach((tag, i) => {
    const entry = breakdown[tag];
    const col = i % cols;
    const row = Math.floor(i / cols);

    // Size proportional to tokens (clamped)
    const ratio = maxTokens > 0 ? entry.tokens / maxTokens : 0.5;
    const boxSize = minBoxSize + ratio * (maxBoxSize - minBoxSize);

    const x = startX + col * (maxBoxSize + cellPadding);
    const y = startY + row * (maxBoxSize + cellPadding);

    const groupId = randomUUID();
    const bg = TAG_COLORS[tag] ?? "#e0e0e0";

    // Box
    elements.push(makeRect(x, y, boxSize, boxSize, bg, [groupId]));

    // Label
    const label = `${tag}\n${entry.files} files\n${entry.tokens.toLocaleString()} tok`;
    elements.push(
      makeText(x + 10, y + 10, label, 14, { groupIds: [groupId] }),
    );
  });

  return wrapFile(elements);
}

// ── Timeline Diagram ─────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  done: "#a8e6cf",
  in_progress: "#ffd3b6",
  pending: "#ffaaa5",
  skipped: "#e0e0e0",
};

/**
 * Generate an Excalidraw JSON object showing a horizontal swimlane
 * timeline of checklist items grouped by phase.
 */
export function generateTimelineDiagram(buildLog: BuildLog): object {
  const items = buildLog.checklist.items;

  if (items.length === 0) {
    return wrapFile([makeText(40, 40, "No checklist items", 20)]);
  }

  // Group items by phase
  const phaseMap = new Map<string, ChecklistItemResult[]>();
  for (const item of items) {
    const list = phaseMap.get(item.phase) ?? [];
    list.push(item);
    phaseMap.set(item.phase, list);
  }

  const elements: ExcalidrawElement[] = [];

  // Title
  elements.push(
    makeText(40, 20, `${buildLog.project} — Build Timeline`, 24),
  );

  // Layout constants
  const laneHeight = 60;
  const lanePadding = 16;
  const labelWidth = 180;
  const startX = 40;
  const startY = 80;
  const pixelsPerMinute = 4;
  const minItemWidth = 80;

  let laneY = startY;

  for (const [phase, phaseItems] of phaseMap) {
    // Phase label on the left
    elements.push(
      makeText(startX, laneY + 14, phase, 16, { textAlign: "left" }),
    );

    // Horizontal lane background
    const totalWidth = labelWidth + phaseItems.length * (minItemWidth + 10) + 200;
    elements.push(
      makeRect(
        startX + labelWidth,
        laneY,
        totalWidth,
        laneHeight,
        "#f5f5f5",
      ),
    );

    // Items in the lane
    let itemX = startX + labelWidth + 10;

    for (const item of phaseItems) {
      const duration = item.durationMinutes ?? 0;
      const boxWidth = Math.max(minItemWidth, duration * pixelsPerMinute);
      const bg = STATUS_COLORS[item.status] ?? "#e0e0e0";

      const groupId = randomUUID();

      // Item box
      elements.push(
        makeRect(itemX, laneY + 6, boxWidth, laneHeight - 12, bg, [groupId]),
      );

      // Item label (truncate long titles)
      const maxLabelLen = Math.floor(boxWidth / 8);
      const truncated =
        item.title.length > maxLabelLen
          ? item.title.slice(0, maxLabelLen - 1) + "…"
          : item.title;

      elements.push(
        makeText(itemX + 6, laneY + 14, truncated, 12, {
          groupIds: [groupId],
          textAlign: "left",
        }),
      );

      itemX += boxWidth + 10;
    }

    laneY += laneHeight + lanePadding;
  }

  return wrapFile(elements);
}

// ── File Writer ──────────────────────────────────────────────────

/**
 * Write both architecture and timeline Excalidraw files to the output
 * directory, creating it if it does not exist.
 *
 * To convert to PNG, open the .excalidraw files in excalidraw.com
 * or ask Claude Code to render them.
 */
export function writeExcalidrawFiles(
  buildLog: BuildLog,
  outputDir: string,
): void {
  mkdirSync(outputDir, { recursive: true });

  const archPath = join(outputDir, "architecture.excalidraw");
  const arch = generateArchitectureDiagram(buildLog);
  writeFileSync(archPath, JSON.stringify(arch, null, 2), "utf-8");

  const timelinePath = join(outputDir, "timeline.excalidraw");
  const timeline = generateTimelineDiagram(buildLog);
  writeFileSync(timelinePath, JSON.stringify(timeline, null, 2), "utf-8");
}
