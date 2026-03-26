import { readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildLog } from "../parsers/types.js";

const __execDir = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(
  readFileSync(join(__execDir, "..", "..", "package.json"), "utf-8")
).version as string;

// ── Helpers ──────────────────────────────────────────────────────────

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function statusBadge(status: string): string {
  const colors: Record<string, { bg: string; fg: string }> = {
    done: { bg: "#d4edda", fg: "#155724" },
    in_progress: { bg: "#fff3cd", fg: "#856404" },
    pending: { bg: "#f8d7da", fg: "#721c24" },
    skipped: { bg: "#e2e3e5", fg: "#383d41" },
  };
  const c = colors[status] ?? colors["pending"]!;
  const label = status.replace("_", " ");
  return `<span class="badge" style="background:${c.bg};color:${c.fg}">${label}</span>`;
}

function confidenceBadge(confidence: string): string {
  const colors: Record<string, { bg: string; fg: string }> = {
    high: { bg: "#d4edda", fg: "#155724" },
    medium: { bg: "#fff3cd", fg: "#856404" },
    low: { bg: "#f8d7da", fg: "#721c24" },
  };
  const c = colors[confidence] ?? colors["low"]!;
  return `<span class="badge" style="background:${c.bg};color:${c.fg}">${confidence}</span>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Phase grouping ───────────────────────────────────────────────────

interface PhaseGroup {
  name: string;
  items: BuildLog["checklist"]["items"];
}

function groupByPhase(items: BuildLog["checklist"]["items"]): PhaseGroup[] {
  const map = new Map<string, BuildLog["checklist"]["items"]>();
  for (const item of items) {
    const phase = item.phase || "Ungrouped";
    if (!map.has(phase)) map.set(phase, []);
    map.get(phase)!.push(item);
  }
  return Array.from(map.entries()).map(([name, phaseItems]) => ({
    name,
    items: phaseItems,
  }));
}

// ── CSS ──────────────────────────────────────────────────────────────

const CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: "Georgia", "Times New Roman", serif;
    color: #1a1a1a;
    line-height: 1.6;
    max-width: 210mm;
    margin: 0 auto;
    padding: 20mm;
    background: #fff;
  }

  h1, h2, h3 { font-family: "Georgia", "Times New Roman", serif; }
  h1 { font-size: 28px; margin-bottom: 4px; }
  h2 { font-size: 20px; margin-top: 32px; margin-bottom: 12px; border-bottom: 2px solid #333; padding-bottom: 4px; }
  h3 { font-size: 16px; margin-top: 20px; margin-bottom: 8px; }

  .title-page {
    text-align: center;
    padding: 60px 0 40px;
    border-bottom: 3px double #333;
    margin-bottom: 32px;
  }
  .title-page .subtitle {
    font-size: 16px;
    color: #555;
    margin-top: 8px;
    font-style: italic;
  }
  .title-page .date {
    font-size: 14px;
    color: #777;
    margin-top: 12px;
  }

  .executive-summary {
    font-size: 15px;
    margin-bottom: 24px;
    text-align: justify;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0 24px;
    font-size: 14px;
  }
  th, td {
    border: 1px solid #ccc;
    padding: 8px 12px;
    text-align: left;
  }
  th {
    background: #f5f5f5;
    font-weight: bold;
    font-family: "Georgia", serif;
  }
  tr:nth-child(even) { background: #fafafa; }

  .badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .phase-section {
    margin-bottom: 24px;
    page-break-inside: avoid;
  }
  .phase-section h3 {
    background: #f5f5f5;
    padding: 6px 12px;
    border-left: 4px solid #333;
  }

  .arch-breakdown {
    margin: 12px 0 24px;
  }
  .arch-bar {
    display: flex;
    align-items: center;
    margin-bottom: 6px;
    font-size: 14px;
  }
  .arch-label {
    width: 100px;
    font-weight: bold;
    text-transform: capitalize;
  }
  .arch-track {
    flex: 1;
    height: 20px;
    background: #eee;
    border-radius: 4px;
    overflow: hidden;
    margin: 0 12px;
  }
  .arch-fill {
    height: 100%;
    background: #4a90d9;
    border-radius: 4px 0 0 4px;
  }
  .arch-pct { width: 50px; text-align: right; }

  .notes-section {
    background: #fff9e6;
    border: 1px solid #e6d98c;
    border-radius: 4px;
    padding: 16px;
    margin-top: 24px;
  }
  .notes-section h3 { border: none; background: none; padding: 0; margin-top: 0; color: #856404; }
  .notes-section ul { margin-left: 20px; margin-top: 8px; }
  .notes-section li { margin-bottom: 4px; font-size: 14px; }

  .footer {
    margin-top: 40px;
    padding-top: 12px;
    border-top: 1px solid #ccc;
    font-size: 12px;
    color: #999;
    text-align: center;
  }

  @media print {
    body { padding: 15mm; }
    .title-page { page-break-after: always; padding: 100px 0 60px; }
    .phase-section { page-break-inside: avoid; }
    .notes-section { page-break-inside: avoid; }
    table { page-break-inside: avoid; }
    @page { size: A4; margin: 15mm; }
  }
`;

// ── HTML Generation ──────────────────────────────────────────────────

export function generateExecutiveSummary(
  buildLog: BuildLog,
  format?: "html",
): string {
  // format param reserved for future expansion; only "html" supported
  void format;

  const { project, generatedAt, checklist, summary } = buildLog;
  const phases = groupByPhase(checklist.items);

  const completionRate =
    summary.itemsTotal > 0
      ? ((summary.itemsCompleted / summary.itemsTotal) * 100).toFixed(1)
      : "0.0";

  const totalTests = summary.testsPassed + summary.testsFailed;
  const testPassRate =
    totalTests > 0
      ? ((summary.testsPassed / totalTests) * 100).toFixed(1)
      : "N/A";

  // Items that are failed or pending
  const noteItems = checklist.items.filter(
    (i) => i.status === "pending" || i.status === "in_progress",
  );

  // Architecture breakdown total for percentages
  const archEntries = Object.entries(summary.architectureBreakdown);
  const archTotalTokens = archEntries.reduce(
    (sum, [, e]) => sum + e.tokens,
    0,
  );

  // ── Build the HTML ─────────────────────────────────────────────────

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(project)} — AI Development Audit Report</title>
  <style>${CSS}</style>
</head>
<body>

<!-- Title Page -->
<div class="title-page">
  <h1>${escapeHtml(project)}</h1>
  <div class="subtitle">AI Development Audit Report</div>
  <div class="date">${formatDate(generatedAt)}</div>
</div>

<!-- Executive Summary -->
<h2>Executive Summary</h2>
<p class="executive-summary">
  The <strong>${escapeHtml(project)}</strong> project was built using an AI-assisted development workflow.
  The build completed ${summary.itemsCompleted} of ${summary.itemsTotal} checklist items
  over a total duration of ${formatDuration(summary.totalDurationMinutes)},
  consuming ${summary.totalTokens.toLocaleString()} tokens
  at an estimated cost of ${formatCost(summary.totalEstimatedCostUsd)}.
  ${totalTests > 0 ? `A total of ${totalTests} tests were created, with ${summary.testsPassed} passing and ${summary.testsFailed} failing.` : "No automated tests were recorded during this build."}
</p>

<!-- Key Metrics -->
<h2>Key Metrics</h2>
<table>
  <thead>
    <tr><th>Metric</th><th>Value</th></tr>
  </thead>
  <tbody>
    <tr><td>Duration</td><td>${formatDuration(summary.totalDurationMinutes)}</td></tr>
    <tr><td>Total Cost</td><td>${formatCost(summary.totalEstimatedCostUsd)}</td></tr>
    <tr><td>Completion Rate</td><td>${completionRate}%</td></tr>
    <tr><td>Test Pass Rate</td><td>${testPassRate === "N/A" ? testPassRate : testPassRate + "%"}</td></tr>
    <tr><td>Files Created</td><td>${summary.filesCreated}</td></tr>
    <tr><td>Total Tokens</td><td>${summary.totalTokens.toLocaleString()}</td></tr>
    <tr><td>Tests Created</td><td>${summary.testsCreated}</td></tr>
  </tbody>
</table>

<!-- Phase Breakdown -->
<h2>Phase Breakdown</h2>
`;

  for (const phase of phases) {
    const phaseDuration = phase.items.reduce(
      (s, i) => s + (i.durationMinutes ?? 0),
      0,
    );
    const phaseCost = phase.items.reduce((s, i) => {
      if (!i.tokens) return s;
      // Rough cost estimate per item based on proportion of total tokens
      const proportion =
        summary.totalTokens > 0 ? i.tokens.total / summary.totalTokens : 0;
      return s + proportion * summary.totalEstimatedCostUsd;
    }, 0);

    html += `
<div class="phase-section">
  <h3>${escapeHtml(phase.name)}</h3>
  <table>
    <thead>
      <tr><th>Item</th><th>Status</th><th>Confidence</th><th>Duration</th><th>Est. Cost</th></tr>
    </thead>
    <tbody>
`;
    for (const item of phase.items) {
      const itemCost =
        item.tokens && summary.totalTokens > 0
          ? (item.tokens.total / summary.totalTokens) *
            summary.totalEstimatedCostUsd
          : 0;

      html += `      <tr>
        <td>${escapeHtml(item.title)}</td>
        <td>${statusBadge(item.status)}</td>
        <td>${confidenceBadge(item.confidence ?? "low")}</td>
        <td>${item.durationMinutes != null ? formatDuration(item.durationMinutes) : "—"}</td>
        <td>${itemCost > 0 ? formatCost(itemCost) : "—"}</td>
      </tr>
`;
    }

    html += `    </tbody>
    <tfoot>
      <tr>
        <th>Phase Total</th>
        <th>${phase.items.filter((i) => i.status === "done").length}/${phase.items.length} done</th>
        <th></th>
        <th>${formatDuration(phaseDuration)}</th>
        <th>${formatCost(phaseCost)}</th>
      </tr>
    </tfoot>
  </table>
</div>
`;
  }

  // Architecture Distribution
  if (archEntries.length > 0) {
    html += `
<h2>Architecture Distribution</h2>
<div class="arch-breakdown">
`;
    for (const [tag, entry] of archEntries) {
      const pct =
        archTotalTokens > 0
          ? ((entry.tokens / archTotalTokens) * 100).toFixed(1)
          : "0.0";

      html += `  <div class="arch-bar">
    <span class="arch-label">${escapeHtml(tag)}</span>
    <div class="arch-track"><div class="arch-fill" style="width:${pct}%"></div></div>
    <span class="arch-pct">${pct}%</span>
  </div>
`;
    }
    html += `</div>
`;
  }

  // Notes section
  if (noteItems.length > 0) {
    html += `
<div class="notes-section">
  <h3>Attention Required</h3>
  <ul>
`;
    for (const item of noteItems) {
      html += `    <li><strong>${escapeHtml(item.title)}</strong> (${escapeHtml(item.phase)}) — ${statusBadge(item.status)}</li>
`;
    }
    html += `  </ul>
</div>
`;
  }

  // Footer
  html += `
<div class="footer">
  Generated by sage-agent-tempo v${VERSION} on ${formatDate(generatedAt)} &middot; Source: ${escapeHtml(checklist.source)}
</div>

</body>
</html>`;

  return html;
}

// ── File writer ──────────────────────────────────────────────────────

export function writeExecutiveSummary(
  buildLog: BuildLog,
  outputPath: string,
): void {
  const html = generateExecutiveSummary(buildLog, "html");
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html, "utf-8");
}
