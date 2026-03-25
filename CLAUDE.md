# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

sage-agent-tempo is a Claude Code skill and CLI tool that creates audit trails of AI agent development work. It parses JSONL session files from Claude Code and Codex, correlates token usage/time/cost against a structured `developer_checklist.yaml`, and generates executive-ready reports (HTML dashboard, executive summary, Excalidraw diagrams).

**Status:** Greenfield — the project has a README, developer checklist, and .gitignore but no source code yet. The `developer_checklist.yaml` is the build plan.

## Build & Test Commands

```bash
npm run build          # Compile TypeScript
npm run test           # Run vitest
npm run test:coverage  # Run vitest with coverage report
```

CLI (after build):
```bash
sage-agent-tempo parse --agent claude-code --checklist developer_checklist.yaml
sage-agent-tempo report --format all
sage-agent-tempo report --format dashboard|executive|excalidraw
sage-agent-tempo backfill --since 2026-03-01
sage-agent-tempo validate
sage-agent-tempo init
```

## Architecture

Two-layer design: **Collection** (runs during/after builds) and **Reporting** (on demand).

### Collection Layer
- **Parsers** (`src/parsers/`) — Read agent-specific JSONL session files, emit `NormalizedTurn[]`. Claude Code parser is primary; Codex is secondary. Each agent needs only one parser — everything downstream is agent-agnostic.
- **Collectors** (`src/collectors/`) — Gather non-token data: git commits, test results, file categorization by architecture tag.
- **Correlator** (`src/correlator/`) — The brain. Joins parser output + checklist + git + tests into `build_log.json`. Correlation priority: explicit item mention → file-based matching → temporal assignment → overhead bucket.

### Report Layer
- **Reporters** (`src/reporters/`) — Each reads `build_log.json` and produces one output format independently.
- **Hooks** (`src/hooks/`) — Claude Code Stop hook triggers the parser at session end.
- **CLI** (`src/cli.ts`) — Entry point using commander.

### Core Data Flow
```
JSONL session files → Parser → NormalizedTurn[]
developer_checklist.yaml → Checklist parser → ParsedChecklist
git log → Git collector → GitCommit[]
                    ↓
              Correlator → build_log.json
                    ↓
              Reporters → HTML dashboard / Executive summary / Excalidraw
```

## Key Technical Decisions

- **TypeScript, functional style** — no classes unless necessary
- **Zod** for runtime validation, **commander** for CLI, **Plotly.js** for charts
- **vitest** as test framework
- **Parse session files post-hoc**, don't capture tokens in real-time hooks. Claude Code writes per-turn token counts to `~/.claude/projects/<path>/<session>.jsonl`.
- **Codex tokens are cumulative** — must compute deltas per turn (current - previous)
- **HTML-first for executive summary** — styled for `@media print`, users Cmd+P to PDF
- **LiteLLM pricing** for cost estimates (API-equivalent, works with Pro/Max subscriptions)
- All file paths use `path.join()` for cross-platform support

## Schemas

- `schemas/build_log.schema.json` — JSON Schema for the unified build log (see README for full spec)
- `schemas/checklist.schema.json` — JSON Schema for `developer_checklist.yaml`
- Core types live in `src/parsers/types.ts`: `AgentEvent`, `NormalizedTurn`, `SessionSummary`

## Checklist Architecture Tags

Tags in `developer_checklist.yaml` drive the architecture breakdown in reports: `backend`, `frontend`, `mcp`, `tools`, `tests`, `config`, `docs`, `data`.

## Development Notes

- The `developer_checklist.yaml` in the repo root is both the build plan for this project AND a real-world test case for the tool itself.
- When working on checklist items, announce "Starting item X.Y" so the correlator can track progress.
- Test fixtures go in `tests/fixtures/` — small hand-crafted fixtures are committed; large/generated ones are gitignored.
- Generated outputs (`build_log.json`, `reports/`, `*.excalidraw`, `dashboard.html`) are gitignored.
