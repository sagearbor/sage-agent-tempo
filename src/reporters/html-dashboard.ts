import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildLog, ChecklistItemResult, ModelUsageEntry, TimelineEvent } from "../parsers/types.js";

const __dashDir = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(
  readFileSync(join(__dashDir, "..", "..", "package.json"), "utf-8")
).version as string;

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
  // Exclude overhead from Gantt — its timestamps are unreliable and dominate the chart
  const withTimes = items.filter((i) => i.startedAt && i.completedAt && i.id !== "_overhead");
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

function phaseBreakdownData(items: ChecklistItemResult[], totalCost: number, totalTokens: number): string {
  const costPerToken = totalTokens > 0 ? totalCost / totalTokens : 0;
  const byPhase: Record<string, { tokens: number; durationMinutes: number; cost: number }> = {};

  for (const item of items) {
    const phase = item.phase || "unknown";
    if (!byPhase[phase]) {
      byPhase[phase] = { tokens: 0, durationMinutes: 0, cost: 0 };
    }
    const itemTokens = item.tokens?.total ?? 0;
    byPhase[phase].tokens += itemTokens;
    byPhase[phase].durationMinutes += item.durationMinutes ?? 0;
    byPhase[phase].cost += itemTokens * costPerToken;
  }

  const entries = Object.entries(byPhase).filter(([, v]) => v.tokens > 0 || v.durationMinutes > 0);
  return JSON.stringify({
    labels: entries.map(([k]) => k),
    costs: entries.map(([, v]) => Math.round(v.cost * 100) / 100),
    durations: entries.map(([, v]) => Math.round(v.durationMinutes * 10) / 10),
    colors: entries.map(([k]) => k.toLowerCase() === "overhead" ? "#bab0ac" : phaseColor(k)),
  });
}

function testResultsData(items: ChecklistItemResult[]): string {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const item of items) {
    passed += item.tests.passed;
    failed += item.tests.failed;
    const ran = item.tests.passed + item.tests.failed;
    if (item.tests.created > ran) skipped += item.tests.created - ran;
  }

  // Per-phase breakdown
  const byPhase: Record<string, { passed: number; failed: number; skipped: number }> = {};
  for (const item of items) {
    const phase = item.phase || "unknown";
    if (!byPhase[phase]) byPhase[phase] = { passed: 0, failed: 0, skipped: 0 };
    byPhase[phase].passed += item.tests.passed;
    byPhase[phase].failed += item.tests.failed;
    const ran = item.tests.passed + item.tests.failed;
    if (item.tests.created > ran) byPhase[phase].skipped += item.tests.created - ran;
  }
  const phaseEntries = Object.entries(byPhase).filter(
    ([, v]) => v.passed + v.failed + v.skipped > 0,
  );

  return JSON.stringify({
    passed,
    failed,
    skipped,
    phases: phaseEntries.map(([k]) => k),
    phasePassed: phaseEntries.map(([, v]) => v.passed),
    phaseFailed: phaseEntries.map(([, v]) => v.failed),
    phaseSkipped: phaseEntries.map(([, v]) => v.skipped),
  });
}

function tokenEfficiencyData(
  timeline: TimelineEvent[],
  items: ChecklistItemResult[],
): string {
  const sorted = [...timeline].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );

  // Build item ID → title lookup
  const itemTitles = new Map<string, string>();
  for (const item of items) {
    itemTitles.set(item.id, `${item.id} ${item.title}`);
  }

  const times: string[] = [];
  const cumulativeTokens: number[] = [];
  const cumulativeItems: number[] = [];
  const activeItems: string[] = [];
  let tokenSum = 0;
  let itemSum = 0;
  let currentItem = "";

  for (const ev of sorted) {
    // Track which checklist item is active
    if (ev.type === "checklist_start" && ev.itemId) {
      currentItem = itemTitles.get(ev.itemId) ?? ev.itemId;
    }
    if (ev.type === "checklist_done" && ev.itemId) {
      currentItem = itemTitles.get(ev.itemId) ?? ev.itemId;
      itemSum++;
      times.push(ev.at);
      cumulativeTokens.push(tokenSum);
      cumulativeItems.push(itemSum);
      activeItems.push(currentItem);
    }
    if (ev.tokens && ev.tokens > 0) {
      // Track active item from tool_call events
      if (ev.itemId) {
        currentItem = itemTitles.get(ev.itemId) ?? ev.itemId;
      }
      tokenSum += ev.tokens;
      times.push(ev.at);
      cumulativeTokens.push(tokenSum);
      cumulativeItems.push(itemSum);
      activeItems.push(currentItem || "overhead");
    }
  }

  // Build "work view" — compress gaps > 10 minutes between events
  const GAP_THRESHOLD_MS = 10 * 60 * 1000;
  const workTimes: string[] = [];
  const workTokens: number[] = [];
  const workItems: number[] = [];
  if (times.length > 0) {
    let offsetMs = 0;
    let prevRealMs = new Date(times[0]).getTime();
    for (let i = 0; i < times.length; i++) {
      const realMs = new Date(times[i]).getTime();
      const gap = realMs - prevRealMs;
      if (gap > GAP_THRESHOLD_MS) {
        offsetMs += gap - 60000;
      }
      const adjustedMs = realMs - offsetMs;
      workTimes.push(new Date(adjustedMs).toISOString());
      workTokens.push(cumulativeTokens[i]);
      workItems.push(cumulativeItems[i]);
      prevRealMs = realMs;
    }
  }

  return JSON.stringify({ times, cumulativeTokens, cumulativeItems, activeItems, workTimes, workTokens, workItems });
}

function modelBreakdownData(modelUsage: ModelUsageEntry[]): string {
  const entries = modelUsage.filter((e) => e.tokens > 0);
  return JSON.stringify({
    labels: entries.map((e) => e.model),
    tokens: entries.map((e) => e.tokens),
    costs: entries.map((e) => Math.round(e.estimatedCostUsd * 100) / 100),
    turns: entries.map((e) => e.turns),
  });
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
    timeZoneName: "short",
  });

  const gantt = ganttChartData(checklist.items);
  const cost = costPerItemData(checklist.items, summary.totalEstimatedCostUsd, summary.totalTokens);
  const arch = archBreakdownData(summary.architectureBreakdown);
  const phases = phaseBreakdownData(checklist.items, summary.totalEstimatedCostUsd, summary.totalTokens);
  const tests = testResultsData(checklist.items);
  const models = modelBreakdownData(summary.modelUsage ?? []);
  const efficiency = tokenEfficiencyData(timeline, checklist.items);

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
    background: #fafaf8;
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
    transition: box-shadow 0.2s ease;
  }
  .kpi:hover {
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
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
    text-overflow: ellipsis;
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
  .chart { width: 100%; min-height: 300px; cursor: grab; }
  .chart-tall { width: 100%; min-height: 400px; cursor: grab; }
  .chart:active, .chart-tall:active { cursor: grabbing; }
  .view-toggle {
    display: inline-flex;
    border: 1px solid #e1e4e8;
    border-radius: 6px;
    overflow: hidden;
    margin-bottom: 8px;
    font-size: 12px;
  }
  .view-toggle button {
    padding: 4px 12px;
    border: none;
    background: #fff;
    color: #6a737d;
    cursor: pointer;
    font-size: 12px;
    transition: background 0.15s, color 0.15s;
  }
  .view-toggle button.active {
    background: #4e79a7;
    color: #fff;
  }
  .view-toggle button:not(.active):hover {
    background: #f0f0f0;
  }
  .footer {
    text-align: center;
    padding: 20px 32px;
    font-size: 12px;
    color: #8b949e;
    border-top: 1px solid #e1e4e8;
    margin-top: 8px;
  }
  @media (max-width: 900px) {
    .grid { grid-template-columns: 1fr; }
    .kpi-row { flex-direction: column; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>${escapeHtml(project)}</h1>
  <div class="subtitle">Generated ${escapeHtml(dateStr)} (v${escapeHtml(VERSION)}) &middot; Agent: ${escapeHtml(buildLog.agent)} &middot; ${buildLog.sessionId.includes(",") ? `${buildLog.sessionId.split(",").length} sessions` : `Session: ${escapeHtml(buildLog.sessionId.slice(0, 12))}…`}</div>
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
    <h2>Cost per Item</h2>
    <div id="costPerItem" class="chart"></div>
  </div>
  <div class="card">
    <h2>Architecture Breakdown</h2>
    <div id="archBreakdown" class="chart"></div>
  </div>
  <div class="card">
    <h2>Phase Breakdown</h2>
    <div id="phaseBreakdown" class="chart"></div>
  </div>
  <div class="card full-width">
    <h2>Token Efficiency</h2>
    <div class="view-toggle" id="effToggle">
      <button class="active" data-view="timeline">Timeline view</button>
      <button data-view="work">Work view</button>
    </div>
    <div style="margin-bottom:8px;font-size:13px;">
      <label style="margin-right:12px;"><input type="checkbox" checked id="effChkTokens"> Cumulative Tokens</label>
      <label><input type="checkbox" checked id="effChkItems"> Items Completed</label>
    </div>
    <div id="tokenEfficiency" class="chart"></div>
  </div>
  <div class="card full-width">
    <h2>Agent &amp; Model Breakdown</h2>
    <div id="modelBreakdown" class="chart"></div>
  </div>
  <div class="card full-width">
    <h2>Test Results (by Phase)</h2>
    <div id="testResults" class="chart"></div>
  </div>
</div>

<div class="footer">Generated by sage-agent-tempo v${VERSION}</div>

<script>
(function() {
  var layout = {
    font: { family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', size: 12 },
    margin: { t: 24, r: 24, b: 40, l: 40 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
  };
  var config = { responsive: true, displayModeBar: true, modeBarButtonsToRemove: ['lasso2d', 'select2d'] };

  // ── Resize all charts on window resize ──────────────────────
  window.addEventListener('resize', function() {
    document.querySelectorAll('.js-plotly-plot').forEach(function(el) {
      Plotly.Plots.resize(el);
    });
  });

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
      textinfo: 'percent',
      hovertemplate: '%{label}<br>%{value} tokens<br>%{percent}<extra></extra>',
      marker: { colors: ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#9c755f'] },
    }], Object.assign({}, layout, {
      showlegend: true,
      legend: { orientation: 'h', y: -0.15 },
    }), config);
  } else {
    ${noDataPlaceholder("archBreakdown")}
  }

  // ── Phase Breakdown ──────────────────────────────────────────
  var phaseData = ${phases};
  if (phaseData.labels.length > 0) {
    var phaseHover = phaseData.labels.map(function(label, i) {
      return label + '<br>$' + phaseData.costs[i].toFixed(2) + ' \\u00b7 ' + phaseData.durations[i] + 'm';
    });
    Plotly.newPlot('phaseBreakdown', [{
      type: 'pie',
      labels: phaseData.labels,
      values: phaseData.costs,
      hole: 0.45,
      text: phaseHover,
      textinfo: 'percent',
      hovertemplate: '%{text}<br>%{percent}<extra></extra>',
      marker: { colors: phaseData.colors },
    }], Object.assign({}, layout, {
      showlegend: true,
      legend: { orientation: 'h', y: -0.15 },
    }), config);
  } else {
    ${noDataPlaceholder("phaseBreakdown")}
  }

  // ── Token Efficiency (dual-axis with timeline/work toggle + checkboxes) ──
  var effData = ${efficiency};
  if (effData.times.length > 0) {
    var effCurrentView = 'timeline';
    function effTokenTrace(view) {
      var t = view === 'work' ? effData.workTimes : effData.times;
      var v = view === 'work' ? effData.workTokens : effData.cumulativeTokens;
      return {
        x: t, y: v, type: 'scatter', mode: 'lines',
        name: 'Cumulative Tokens', line: { color: '#4e79a7', width: 2 }, yaxis: 'y',
        customdata: effData.activeItems,
        hovertemplate: '%{x}<br>Tokens: %{y:,.0f}<br>Working on: %{customdata}<extra></extra>',
      };
    }
    function effItemTrace(view) {
      var t = view === 'work' ? effData.workTimes : effData.times;
      var v = view === 'work' ? effData.workItems : effData.cumulativeItems;
      return {
        x: t, y: v, type: 'scatter', mode: 'lines',
        name: 'Items Completed', line: { color: '#59a14f', width: 2, shape: 'hv' }, yaxis: 'y2',
        customdata: effData.activeItems,
        hovertemplate: '%{x}<br>Items done: %{y}<br>Working on: %{customdata}<extra></extra>',
      };
    }
    function effLayout(view) {
      return Object.assign({}, layout, {
        xaxis: { title: view === 'work' ? 'Active Work Time' : 'Time' },
        yaxis: { title: 'Cumulative Tokens', side: 'left', showgrid: false },
        yaxis2: { title: 'Items Completed', side: 'right', overlaying: 'y', showgrid: false },
        legend: { orientation: 'h', y: -0.2 },
        margin: { t: 24, r: 60, b: 48, l: 60 },
      });
    }
    Plotly.newPlot('tokenEfficiency', [effTokenTrace('timeline'), effItemTrace('timeline')], effLayout('timeline'), config);

    // View toggle handler
    var effToggleEl = document.getElementById('effToggle');
    if (effToggleEl) {
      effToggleEl.addEventListener('click', function(e) {
        var btn = e.target;
        if (!btn.dataset || !btn.dataset.view) return;
        effToggleEl.querySelectorAll('button').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        effCurrentView = btn.dataset.view;
        var tokChk = document.getElementById('effChkTokens');
        var itmChk = document.getElementById('effChkItems');
        var t1 = effTokenTrace(effCurrentView);
        var t2 = effItemTrace(effCurrentView);
        t1.visible = tokChk.checked ? true : 'legendonly';
        t2.visible = itmChk.checked ? true : 'legendonly';
        Plotly.react('tokenEfficiency', [t1, t2], effLayout(effCurrentView), config);
      });
    }

    // Checkbox handlers
    var effChkTokens = document.getElementById('effChkTokens');
    var effChkItems = document.getElementById('effChkItems');
    if (effChkTokens) {
      effChkTokens.addEventListener('change', function() {
        Plotly.restyle('tokenEfficiency', { visible: this.checked ? true : 'legendonly' }, [0]);
      });
    }
    if (effChkItems) {
      effChkItems.addEventListener('change', function() {
        Plotly.restyle('tokenEfficiency', { visible: this.checked ? true : 'legendonly' }, [1]);
      });
    }
  } else {
    ${noDataPlaceholder("tokenEfficiency")}
  }

  // ── Model Breakdown ─────────────────────────────────────────
  var modelData = ${models};
  if (modelData.labels.length > 0) {
    var modelText = modelData.labels.map(function(label, i) {
      return label + '<br>' + modelData.tokens[i].toLocaleString() + ' tokens<br>$' + modelData.costs[i].toFixed(2);
    });
    var modelColors = ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#9c755f','#ff9da7','#86bcb6'];
    Plotly.newPlot('modelBreakdown', [{
      type: 'pie',
      labels: modelData.labels,
      values: modelData.tokens,
      hole: 0.5,
      text: modelText,
      textinfo: 'percent',
      hovertemplate: '%{text}<extra></extra>',
      marker: { colors: modelColors.slice(0, modelData.labels.length) },
      textposition: 'outside',
      automargin: true,
    }], Object.assign({}, layout, {
      showlegend: true,
      legend: { orientation: 'h', y: -0.15 },
      annotations: [{
        text: modelData.labels.length + ' model' + (modelData.labels.length > 1 ? 's' : ''),
        showarrow: false,
        font: { size: 14, color: '#6a737d' },
        x: 0.5,
        y: 0.5,
      }],
    }), config);
  } else {
    ${noDataPlaceholder("modelBreakdown")}
  }

  // ── Test Results (per-phase grouped bar) ────────────────────
  var testData = ${tests};
  if (testData.phases && testData.phases.length > 0) {
    Plotly.newPlot('testResults', [
      { type: 'bar', name: 'Passed', x: testData.phases, y: testData.phasePassed, marker: { color: '#59a14f' } },
      { type: 'bar', name: 'Failed', x: testData.phases, y: testData.phaseFailed, marker: { color: '#e15759' } },
      { type: 'bar', name: 'Skipped', x: testData.phases, y: testData.phaseSkipped, marker: { color: '#bab0ac' } },
    ], Object.assign({}, layout, {
      barmode: 'group',
      xaxis: { title: 'Phase' },
      yaxis: { title: 'Count' },
      legend: { orientation: 'h', y: -0.2 },
    }), config);
  } else if (testData.passed + testData.failed + testData.skipped > 0) {
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
