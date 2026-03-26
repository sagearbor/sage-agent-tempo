import { writeFileSync } from "node:fs";
import type { BuildLog } from "../parsers/types.js";

// ── Color palette for projects ──────────────────────────────────────
const PROJECT_COLORS = [
  "#4e79a7",
  "#f28e2b",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
];

function projectColor(index: number): string {
  return PROJECT_COLORS[index % PROJECT_COLORS.length];
}

// ── Helpers ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

// ── Data structures for charts ──────────────────────────────────────

interface ProjectSummaryRow {
  name: string;
  duration: string;
  durationMinutes: number;
  tokens: number;
  cost: string;
  costUsd: number;
  itemsCompleted: number;
  itemsTotal: number;
  filesCreated: number;
}

function buildSummaryRows(logs: BuildLog[]): ProjectSummaryRow[] {
  return logs.map((log) => ({
    name: log.project,
    duration: fmtDuration(log.summary.totalDurationMinutes),
    durationMinutes: log.summary.totalDurationMinutes,
    tokens: log.summary.totalTokens,
    cost: fmtCost(log.summary.totalEstimatedCostUsd),
    costUsd: log.summary.totalEstimatedCostUsd,
    itemsCompleted: log.summary.itemsCompleted,
    itemsTotal: log.summary.itemsTotal,
    filesCreated: log.summary.filesCreated,
  }));
}

function tokenBurnComparisonData(logs: BuildLog[]): string {
  const series = logs.map((log, idx) => {
    const sorted = [...log.timeline]
      .filter((e) => e.tokens && e.tokens > 0)
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    let cumulative = 0;
    const times: string[] = [];
    const values: number[] = [];
    for (const ev of sorted) {
      cumulative += ev.tokens ?? 0;
      times.push(ev.at);
      values.push(cumulative);
    }

    return {
      name: log.project,
      times,
      values,
      color: projectColor(idx),
    };
  });

  return JSON.stringify(series);
}

function costByPhaseData(logs: BuildLog[]): string {
  // Collect all unique phases across all projects
  const allPhases = new Set<string>();
  for (const log of logs) {
    for (const item of log.checklist.items) {
      allPhases.add(item.phase);
    }
  }
  const phases = [...allPhases].sort();

  const projects = logs.map((log, idx) => {
    const costPerToken =
      log.summary.totalTokens > 0
        ? log.summary.totalEstimatedCostUsd / log.summary.totalTokens
        : 0;

    const phaseCosts: Record<string, number> = {};
    for (const item of log.checklist.items) {
      const phase = item.phase;
      const itemTokens = item.tokens?.total ?? 0;
      phaseCosts[phase] = (phaseCosts[phase] ?? 0) + itemTokens * costPerToken;
    }

    return {
      name: log.project,
      phaseCosts,
      color: projectColor(idx),
    };
  });

  return JSON.stringify({ phases, projects });
}

function architectureComparisonData(logs: BuildLog[]): string {
  // Collect all unique architecture tags
  const allTags = new Set<string>();
  for (const log of logs) {
    for (const tag of Object.keys(log.summary.architectureBreakdown)) {
      allTags.add(tag);
    }
  }
  const tags = [...allTags].sort();

  const projects = logs.map((log, idx) => ({
    name: log.project,
    tokensByTag: tags.map(
      (tag) => log.summary.architectureBreakdown[tag]?.tokens ?? 0
    ),
    color: projectColor(idx),
  }));

  return JSON.stringify({ tags, projects });
}

// ── Main HTML generation ────────────────────────────────────────────

export function generateComparisonDashboard(logs: BuildLog[]): string {
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const rows = buildSummaryRows(logs);
  const tokenBurn = tokenBurnComparisonData(logs);
  const costPhase = costByPhaseData(logs);
  const archComp = architectureComparisonData(logs);

  const summaryTableRows = rows
    .map(
      (r) =>
        `<tr>
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.duration)}</td>
          <td>${r.tokens.toLocaleString()}</td>
          <td>${escapeHtml(r.cost)}</td>
          <td>${r.itemsCompleted}/${r.itemsTotal}</td>
          <td>${r.filesCreated}</td>
        </tr>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cross-Project Comparison Dashboard</title>
<script src="https://cdn.plot.ly/plotly-2.35.0.min.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f5f6f8;
    color: #1d1d1f;
    line-height: 1.5;
  }
  .header {
    background: #fff;
    border-bottom: 1px solid #e1e4e8;
    padding: 24px 32px;
  }
  .header h1 {
    font-size: 22px;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .header .subtitle {
    font-size: 13px;
    color: #6a737d;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    padding: 20px 32px 32px;
  }
  .card {
    background: #fff;
    border: 1px solid #e1e4e8;
    border-radius: 8px;
    padding: 20px;
    overflow: hidden;
  }
  .card.full-width {
    grid-column: 1 / -1;
  }
  .card h2 {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 12px;
    color: #24292e;
  }
  .chart { width: 100%; min-height: 300px; }
  .chart-tall { width: 100%; min-height: 400px; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  th, td {
    text-align: left;
    padding: 10px 14px;
    border-bottom: 1px solid #e1e4e8;
  }
  th {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #6a737d;
    font-weight: 600;
    background: #fafbfc;
  }
  tr:last-child td {
    border-bottom: none;
  }
  @media (max-width: 900px) {
    .grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>Cross-Project Comparison</h1>
  <div class="subtitle">Generated ${escapeHtml(dateStr)} &middot; ${logs.length} project(s) compared</div>
</div>

<div class="grid">
  <div class="card full-width">
    <h2>Project Summary</h2>
    <table>
      <thead>
        <tr>
          <th>Project</th>
          <th>Duration</th>
          <th>Total Tokens</th>
          <th>Est. Cost</th>
          <th>Items Completed</th>
          <th>Files Created</th>
        </tr>
      </thead>
      <tbody>
        ${summaryTableRows}
      </tbody>
    </table>
  </div>

  <div class="card full-width">
    <h2>Cumulative Token Burn</h2>
    <div id="tokenBurn" class="chart-tall"></div>
  </div>

  <div class="card">
    <h2>Cost by Phase</h2>
    <div id="costByPhase" class="chart"></div>
  </div>

  <div class="card">
    <h2>Architecture Token Distribution</h2>
    <div id="archComparison" class="chart"></div>
  </div>
</div>

<script>
(function() {
  var layout = {
    font: { family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', size: 12 },
    margin: { t: 24, r: 24, b: 40, l: 60 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
  };
  var config = { displayModeBar: false, responsive: true };

  // ── Token Burn (one line per project) ─────────────────────────
  var burnSeries = ${tokenBurn};
  var hasAnyBurnData = burnSeries.some(function(s) { return s.times.length > 0; });
  if (hasAnyBurnData) {
    var burnTraces = burnSeries.filter(function(s) { return s.times.length > 0; }).map(function(s) {
      return {
        x: s.times,
        y: s.values,
        type: 'scatter',
        mode: 'lines',
        name: s.name,
        line: { color: s.color, width: 2 },
      };
    });
    Plotly.newPlot('tokenBurn', burnTraces, Object.assign({}, layout, {
      xaxis: { title: 'Time' },
      yaxis: { title: 'Cumulative Tokens' },
      legend: { orientation: 'h', y: -0.15 },
    }), config);
  } else {
    document.getElementById('tokenBurn').textContent = 'No timeline data available.';
    document.getElementById('tokenBurn').style.cssText = 'color:#6a737d;padding:40px;text-align:center';
  }

  // ── Cost by Phase (grouped bar chart) ─────────────────────────
  var costData = ${costPhase};
  if (costData.phases.length > 0) {
    var costTraces = costData.projects.map(function(proj) {
      return {
        type: 'bar',
        name: proj.name,
        x: costData.phases,
        y: costData.phases.map(function(phase) {
          return Math.round((proj.phaseCosts[phase] || 0) * 100) / 100;
        }),
        marker: { color: proj.color },
        hovertemplate: '%{x}: $%{y:.2f}<extra>' + proj.name + '</extra>',
      };
    });
    Plotly.newPlot('costByPhase', costTraces, Object.assign({}, layout, {
      barmode: 'group',
      xaxis: { title: 'Phase' },
      yaxis: { title: 'Cost (USD)' },
      legend: { orientation: 'h', y: -0.2 },
    }), config);
  } else {
    document.getElementById('costByPhase').textContent = 'No phase data available.';
    document.getElementById('costByPhase').style.cssText = 'color:#6a737d;padding:40px;text-align:center';
  }

  // ── Architecture Comparison (grouped bar chart) ───────────────
  var archData = ${archComp};
  if (archData.tags.length > 0) {
    var archTraces = archData.projects.map(function(proj) {
      return {
        type: 'bar',
        name: proj.name,
        x: archData.tags,
        y: proj.tokensByTag,
        marker: { color: proj.color },
        hovertemplate: '%{x}: %{y:,.0f} tokens<extra>' + proj.name + '</extra>',
      };
    });
    Plotly.newPlot('archComparison', archTraces, Object.assign({}, layout, {
      barmode: 'group',
      xaxis: { title: 'Architecture Tag' },
      yaxis: { title: 'Tokens' },
      legend: { orientation: 'h', y: -0.2 },
    }), config);
  } else {
    document.getElementById('archComparison').textContent = 'No architecture data available.';
    document.getElementById('archComparison').style.cssText = 'color:#6a737d;padding:40px;text-align:center';
  }
})();
</script>
</body>
</html>`;
}

// ── File writer ─────────────────────────────────────────────────────

export function writeComparisonDashboard(
  logs: BuildLog[],
  outputPath: string
): void {
  const html = generateComparisonDashboard(logs);
  writeFileSync(outputPath, html, "utf-8");
}
