import { writeFileSync } from "node:fs";
import type { BuildLog, ChecklistItemResult, TimelineEvent } from "../parsers/types.js";

// ── Color palette for phases ────────────────────────────────────────
const PHASE_COLORS: Record<string, string> = {
  setup: "#4e79a7",
  scaffold: "#59a14f",
  core: "#f28e2b",
  integration: "#e15759",
  testing: "#76b7b2",
  polish: "#b07aa1",
  deploy: "#ff9da7",
  docs: "#9c755f",
};

function phaseColor(phase: string): string {
  const key = phase.toLowerCase().replace(/[^a-z]/g, "");
  if (PHASE_COLORS[key]) return PHASE_COLORS[key];
  // Deterministic fallback from a secondary palette
  const fallback = ["#edc948", "#bab0ac", "#af7aa1", "#86bcb6", "#d37295"];
  let hash = 0;
  for (let i = 0; i < phase.length; i++) hash = (hash * 31 + phase.charCodeAt(i)) | 0;
  return fallback[Math.abs(hash) % fallback.length];
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

function testPassRate(log: BuildLog): string {
  const total = log.summary.testsPassed + log.summary.testsFailed;
  if (total === 0) return "N/A";
  return `${Math.round((log.summary.testsPassed / total) * 100)}%`;
}

// ── Chart data builders ─────────────────────────────────────────────

function ganttChartData(items: ChecklistItemResult[]): string {
  const withTimes = items.filter((i) => i.startedAt && i.completedAt);
  if (withTimes.length === 0) {
    // Fallback: use index-based positioning when timestamps are missing
    const labels = items.map((i) => escapeHtml(i.title));
    const durations = items.map((i) => i.durationMinutes ?? 0);
    const colors = items.map((i) => phaseColor(i.phase));
    const phases = items.map((i) => i.phase);
    return JSON.stringify({
      labels,
      durations,
      colors,
      phases,
      mode: "duration",
    });
  }

  const labels = withTimes.map((i) => escapeHtml(i.title));
  const starts = withTimes.map((i) => i.startedAt);
  const ends = withTimes.map((i) => i.completedAt);
  const colors = withTimes.map((i) => phaseColor(i.phase));
  const phases = withTimes.map((i) => i.phase);
  return JSON.stringify({
    labels,
    starts,
    ends,
    colors,
    phases,
    mode: "time",
  });
}

function tokenBurnData(timeline: TimelineEvent[]): string {
  const sorted = [...timeline]
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
  return JSON.stringify({ times, values });
}

function costPerItemData(items: ChecklistItemResult[], totalCost: number, totalTokens: number): string {
  const costPerToken = totalTokens > 0 ? totalCost / totalTokens : 0;
  const entries = items
    .map((i) => ({
      title: escapeHtml(i.title),
      cost: (i.tokens?.total ?? 0) * costPerToken,
    }))
    .filter((e) => e.cost > 0)
    .sort((a, b) => b.cost - a.cost);

  return JSON.stringify({
    labels: entries.map((e) => e.title),
    values: entries.map((e) => Math.round(e.cost * 100) / 100),
  });
}

function archBreakdownData(breakdown: Record<string, { tokens: number; files: number; durationMinutes: number }>): string {
  const entries = Object.entries(breakdown).filter(([, v]) => v.tokens > 0);
  return JSON.stringify({
    labels: entries.map(([k]) => k),
    values: entries.map(([, v]) => v.tokens),
  });
}

function testResultsData(items: ChecklistItemResult[]): string {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const item of items) {
    passed += item.tests.passed;
    failed += item.tests.failed;
    // "created" minus passed+failed gives a rough skip count
    const ran = item.tests.passed + item.tests.failed;
    if (item.tests.created > ran) skipped += item.tests.created - ran;
  }
  return JSON.stringify({ passed, failed, skipped });
}

// ── Placeholder helper (avoids innerHTML with dynamic content) ──────

function noDataPlaceholder(id: string): string {
  return `document.getElementById('${id}').textContent = 'No data available.';
    document.getElementById('${id}').style.cssText = 'color:#6a737d;padding:40px;text-align:center';`;
}

// ── Main HTML generation ────────────────────────────────────────────

export function generateDashboard(buildLog: BuildLog): string {
  const { project, generatedAt, summary, checklist, timeline } = buildLog;
  const dateStr = new Date(generatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const gantt = ganttChartData(checklist.items);
  const burn = tokenBurnData(timeline);
  const cost = costPerItemData(checklist.items, summary.totalEstimatedCostUsd, summary.totalTokens);
  const arch = archBreakdownData(summary.architectureBreakdown);
  const tests = testResultsData(checklist.items);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(project)} — Build Dashboard</title>
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
  .kpi-row {
    display: flex;
    gap: 16px;
    padding: 20px 32px;
    flex-wrap: wrap;
  }
  .kpi {
    background: #fff;
    border: 1px solid #e1e4e8;
    border-radius: 8px;
    padding: 16px 24px;
    flex: 1 1 140px;
    min-width: 140px;
  }
  .kpi .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #6a737d;
    margin-bottom: 4px;
  }
  .kpi .value {
    font-size: 24px;
    font-weight: 600;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    padding: 0 32px 32px;
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
  @media (max-width: 900px) {
    .grid { grid-template-columns: 1fr; }
    .kpi-row { flex-direction: column; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>${escapeHtml(project)}</h1>
  <div class="subtitle">Generated ${escapeHtml(dateStr)} &middot; Agent: ${escapeHtml(buildLog.agent)} &middot; Session: ${escapeHtml(buildLog.sessionId)}</div>
</div>

<div class="kpi-row">
  <div class="kpi">
    <div class="label">Duration</div>
    <div class="value">${fmtDuration(summary.totalDurationMinutes)}</div>
  </div>
  <div class="kpi">
    <div class="label">Total Tokens</div>
    <div class="value">${summary.totalTokens.toLocaleString()}</div>
  </div>
  <div class="kpi">
    <div class="label">Estimated Cost</div>
    <div class="value">${fmtCost(summary.totalEstimatedCostUsd)}</div>
  </div>
  <div class="kpi">
    <div class="label">Checklist Progress</div>
    <div class="value">${summary.itemsCompleted}/${summary.itemsTotal}</div>
  </div>
  <div class="kpi">
    <div class="label">Test Pass Rate</div>
    <div class="value">${testPassRate(buildLog)}</div>
  </div>
</div>

<div class="grid">
  <div class="card full-width">
    <h2>Checklist Gantt</h2>
    <div id="gantt" class="chart-tall"></div>
  </div>
  <div class="card">
    <h2>Token Burn (Cumulative)</h2>
    <div id="tokenBurn" class="chart"></div>
  </div>
  <div class="card">
    <h2>Cost per Item</h2>
    <div id="costPerItem" class="chart"></div>
  </div>
  <div class="card">
    <h2>Architecture Breakdown</h2>
    <div id="archBreakdown" class="chart"></div>
  </div>
  <div class="card">
    <h2>Test Results</h2>
    <div id="testResults" class="chart"></div>
  </div>
</div>

<script>
(function() {
  var layout = {
    font: { family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', size: 12 },
    margin: { t: 24, r: 24, b: 40, l: 40 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
  };
  var config = { displayModeBar: false, responsive: true };

  // ── Gantt ─────────────────────────────────────────────────────
  var ganttData = ${gantt};
  if (ganttData.mode === 'time') {
    var traces = [];
    var uniquePhases = [];
    ganttData.phases.forEach(function(p) { if (uniquePhases.indexOf(p) === -1) uniquePhases.push(p); });
    uniquePhases.forEach(function(phase) {
      var idx = [];
      ganttData.phases.forEach(function(p, i) { if (p === phase) idx.push(i); });
      traces.push({
        type: 'bar',
        orientation: 'h',
        name: phase,
        y: idx.map(function(i) { return ganttData.labels[i]; }),
        x: idx.map(function(i) {
          return (new Date(ganttData.ends[i]).getTime() - new Date(ganttData.starts[i]).getTime()) / 60000;
        }),
        base: idx.map(function(i) {
          var origin = new Date(ganttData.starts[0]).getTime();
          return (new Date(ganttData.starts[i]).getTime() - origin) / 60000;
        }),
        marker: { color: ganttData.colors[idx[0]] },
        hovertemplate: '%{y}: %{x:.1f} min<extra>' + phase + '</extra>',
      });
    });
    Plotly.newPlot('gantt', traces, Object.assign({}, layout, {
      barmode: 'stack',
      xaxis: { title: 'Minutes from start' },
      yaxis: { autorange: 'reversed', automargin: true },
      margin: { t: 24, r: 24, b: 48, l: 200 },
      showlegend: true,
      legend: { orientation: 'h', y: -0.15 },
    }), config);
  } else {
    Plotly.newPlot('gantt', [{
      type: 'bar',
      orientation: 'h',
      y: ganttData.labels,
      x: ganttData.durations,
      marker: { color: ganttData.colors },
      hovertemplate: '%{y}: %{x:.1f} min<extra></extra>',
    }], Object.assign({}, layout, {
      xaxis: { title: 'Duration (min)' },
      yaxis: { autorange: 'reversed', automargin: true },
      margin: { t: 24, r: 24, b: 48, l: 200 },
    }), config);
  }

  // ── Token Burn ────────────────────────────────────────────────
  var burnData = ${burn};
  if (burnData.times.length > 0) {
    Plotly.newPlot('tokenBurn', [{
      x: burnData.times,
      y: burnData.values,
      type: 'scatter',
      mode: 'lines',
      fill: 'tozeroy',
      line: { color: '#4e79a7', width: 2 },
      fillcolor: 'rgba(78,121,167,0.12)',
    }], Object.assign({}, layout, {
      xaxis: { title: 'Time' },
      yaxis: { title: 'Cumulative Tokens' },
    }), config);
  } else {
    ${noDataPlaceholder("tokenBurn")}
  }

  // ── Cost per Item ─────────────────────────────────────────────
  var costData = ${cost};
  if (costData.labels.length > 0) {
    Plotly.newPlot('costPerItem', [{
      type: 'bar',
      orientation: 'h',
      y: costData.labels,
      x: costData.values,
      marker: { color: '#59a14f' },
      hovertemplate: '%{y}: $%{x:.2f}<extra></extra>',
    }], Object.assign({}, layout, {
      xaxis: { title: 'Cost (USD)' },
      yaxis: { automargin: true },
      margin: { t: 24, r: 24, b: 48, l: 200 },
    }), config);
  } else {
    ${noDataPlaceholder("costPerItem")}
  }

  // ── Architecture Breakdown ────────────────────────────────────
  var archData = ${arch};
  if (archData.labels.length > 0) {
    Plotly.newPlot('archBreakdown', [{
      type: 'pie',
      labels: archData.labels,
      values: archData.values,
      hole: 0.45,
      textinfo: 'label+percent',
      marker: { colors: ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#9c755f'] },
    }], Object.assign({}, layout, {
      showlegend: false,
    }), config);
  } else {
    ${noDataPlaceholder("archBreakdown")}
  }

  // ── Test Results ──────────────────────────────────────────────
  var testData = ${tests};
  if (testData.passed + testData.failed + testData.skipped > 0) {
    Plotly.newPlot('testResults', [
      { type: 'bar', name: 'Passed', x: ['Tests'], y: [testData.passed], marker: { color: '#59a14f' } },
      { type: 'bar', name: 'Failed', x: ['Tests'], y: [testData.failed], marker: { color: '#e15759' } },
      { type: 'bar', name: 'Skipped', x: ['Tests'], y: [testData.skipped], marker: { color: '#bab0ac' } },
    ], Object.assign({}, layout, {
      barmode: 'stack',
      yaxis: { title: 'Count' },
      legend: { orientation: 'h', y: -0.2 },
    }), config);
  } else {
    ${noDataPlaceholder("testResults")}
  }
})();
</script>
</body>
</html>`;
}

// ── File writer ─────────────────────────────────────────────────────

export function writeDashboard(buildLog: BuildLog, outputPath: string): void {
  const html = generateDashboard(buildLog);
  writeFileSync(outputPath, html, "utf-8");
}
