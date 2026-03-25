# sage-agent-tempo

Reusable skill for tracking what AI agents build, how long it takes, and what it costs. Drop into any repo.

A Claude Code skill (and CLI tool) that creates a complete audit trail of AI agent development work — tracking what was built, how long each step took, what it cost in tokens, and whether the tests pass. Get C-suite-ready reports showing exactly how AI built your software.

## The problem

You ask Claude Code (or Codex) to build something from a checklist. 45 minutes later it's done. But you can't answer basic questions: How much did each feature cost in tokens? Which checklist items took longest? How many tests were created? What percentage was backend vs frontend? Did the agent get stuck anywhere?

The raw data exists — Claude Code writes detailed JSONL session files with per-turn token counts, timestamps, and every tool call. But nobody is correlating that data against a structured plan and turning it into something a non-technical stakeholder can understand.

## What this does

**During the build** — lightweight hooks and a JSONL parser capture what's happening:

- Per-turn token usage (input, output, cache) with timestamps from session files
- Which `developer_checklist.yaml` item is being worked on (inferred from agent messages + timestamps)
- Files created, modified, and deleted (from tool call logs)
- Test results (created, passed, failed, skipped)
- Git commits correlated with checklist items
- Architecture tags (backend, frontend, MCP, tools, config, tests, docs)

**After the build** — a report generator reads the unified log and produces:

1. **Executive summary** (PDF/DOCX) — one-page overview + detailed breakdown. For people who can't open `.md` files.
2. **Interactive HTML dashboard** — Gantt chart, cost-per-feature breakdown, token burn timeline, architecture pie chart. Email it to anyone, they double-click to open in a browser.
3. **Excalidraw diagrams** — architecture breakdown and timeline visuals via the `excalidraw-diagram-generator` skill.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Collection layer (runs during/after build)      │
│                                                   │
│  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ CC Stop hook  │  │ JSONL parser              │  │
│  │ (triggers     │──│ Reads ~/.claude/projects/ │  │
│  │  parser)      │  │ Extracts per-turn tokens  │  │
│  └──────────────┘  └──────────┬───────────────┘  │
│                               │                   │
│  ┌──────────────┐  ┌─────────▼────────────────┐  │
│  │ Checklist    │──│ build_log.json            │  │
│  │ tracker      │  │ (unified event log)       │  │
│  └──────────────┘  └─────────┬────────────────┘  │
│  ┌──────────────┐            │                   │
│  │ Git tracker  │────────────┘                   │
│  └──────────────┘                                 │
└──────────────────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────┐
│  Report layer (runs on demand)                    │
│                                                   │
│  ┌────────────┐ ┌────────────┐ ┌──────────────┐ │
│  │ Executive  │ │ HTML       │ │ Excalidraw   │ │
│  │ summary    │ │ dashboard  │ │ diagrams     │ │
│  │ (PDF/DOCX) │ │ (Plotly)   │ │ (.excalidraw)│ │
│  └────────────┘ └────────────┘ └──────────────┘ │
└──────────────────────────────────────────────────┘
```

## Key design decisions

**Parse session files, don't rely on hooks for token data.** Claude Code already writes per-turn token counts to `~/.claude/projects/<path>/<session>.jsonl`. Every assistant message includes `inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`. Parsing these post-hoc is simpler and more reliable than trying to capture tokens in real-time hooks. Hooks are only used to trigger the parser at session end.

**Agent-agnostic log schema.** Claude Code and Codex have different JSONL formats, but both feed into the same `build_log.json` schema. Adding a new agent means writing one parser — everything downstream (reports, dashboards, diagrams) works automatically.

**Greenfield-first, old repos if possible.** The skill works best when activated before the build starts. For existing repos, a `backfill` command can attempt to reconstruct a partial log from existing JSONL session files and git history, but it won't have checklist correlation.

**Subscription-friendly.** Works with Pro/Max monthly accounts (reads local files), not just API billing. Cost estimates use LiteLLM pricing as API-equivalent costs for relative comparison.

## Project structure

```
sage-agent-tempo/
├── SKILL.md                    # Claude Code skill definition
├── CLAUDE.md                   # Instructions for agents working on this repo
├── developer_checklist.yaml    # The checklist for building THIS project
├── README.md
├── package.json
│
├── src/
│   ├── parsers/
│   │   ├── claude-code.ts      # Parse CC JSONL → normalized events
│   │   ├── codex.ts            # Parse Codex JSONL → normalized events
│   │   └── types.ts            # Shared event schema (AgentEvent, etc.)
│   │
│   ├── collectors/
│   │   ├── checklist.ts        # Read developer_checklist.yaml, track status
│   │   ├── git.ts              # Extract commits, file changes, diffs
│   │   └── test-results.ts     # Parse test runner output (jest, pytest, etc.)
│   │
│   ├── correlator/
│   │   └── index.ts            # Join parser output + checklist + git → build_log.json
│   │
│   ├── reporters/
│   │   ├── executive-summary.ts  # Generate PDF/DOCX report
│   │   ├── html-dashboard.ts     # Generate self-contained HTML with Plotly
│   │   ├── excalidraw.ts         # Generate .excalidraw diagram files
│   │   └── templates/            # HTML/CSS templates for dashboard
│   │
│   ├── hooks/
│   │   └── stop-hook.sh        # Claude Code Stop hook (triggers parser)
│   │
│   └── cli.ts                  # CLI entry point
│
├── schemas/
│   ├── build_log.schema.json   # JSON Schema for build_log.json
│   └── checklist.schema.json   # JSON Schema for developer_checklist.yaml
│
└── tests/
    ├── fixtures/               # Sample JSONL files, checklists
    ├── parsers/
    ├── collectors/
    ├── correlator/
    └── reporters/
```

## The build_log.json schema (core)

Every event in the log follows this structure:

```jsonc
{
  "project": "aact-reverse-engineering",
  "agent": "claude-code",              // or "codex", "future-agent"
  "session_id": "abc123-def456",
  "generated_at": "2026-03-25T14:30:00Z",

  "checklist": {
    "source": "developer_checklist.yaml",
    "items": [
      {
        "id": "1.1",
        "title": "Set up project scaffolding",
        "phase": "setup",
        "tags": ["config", "backend"],
        "status": "done",
        "started_at": "2026-03-25T10:00:00Z",
        "completed_at": "2026-03-25T10:12:00Z",
        "duration_minutes": 12,
        "tokens": {
          "input": 45200,
          "output": 12800,
          "cache_read": 38000,
          "cache_creation": 2400,
          "total": 98400,
          "estimated_cost_usd": 0.42
        },
        "turns": 8,
        "tools_used": ["Write", "Bash", "Read"],
        "files_created": ["package.json", "tsconfig.json", "src/index.ts"],
        "files_modified": [],
        "tests": { "created": 0, "passed": 0, "failed": 0 },
        "git_commits": ["a1b2c3d"]
      }
      // ... more items
    ]
  },

  "summary": {
    "total_duration_minutes": 47,
    "total_tokens": 1250000,
    "total_estimated_cost_usd": 5.80,
    "items_completed": 12,
    "items_total": 15,
    "tests_created": 24,
    "tests_passed": 22,
    "tests_failed": 2,
    "files_created": 34,
    "architecture_breakdown": {
      "backend": { "tokens": 580000, "files": 14, "duration_minutes": 22 },
      "frontend": { "tokens": 340000, "files": 8, "duration_minutes": 12 },
      "mcp_tools": { "tokens": 120000, "files": 4, "duration_minutes": 5 },
      "tests": { "tokens": 150000, "files": 6, "duration_minutes": 6 },
      "config": { "tokens": 60000, "files": 2, "duration_minutes": 2 }
    }
  },

  "timeline": [
    // Raw event stream for Gantt chart rendering
    { "type": "checklist_start", "item_id": "1.1", "at": "2026-03-25T10:00:00Z" },
    { "type": "tool_call", "tool": "Write", "file": "package.json", "at": "2026-03-25T10:01:12Z", "tokens": 3200 },
    { "type": "test_run", "passed": 5, "failed": 0, "at": "2026-03-25T10:08:00Z" },
    { "type": "git_commit", "sha": "a1b2c3d", "message": "init project", "at": "2026-03-25T10:09:00Z" },
    { "type": "checklist_done", "item_id": "1.1", "at": "2026-03-25T10:12:00Z" }
    // ... more events
  ]
}
```

## Usage

### As a Claude Code skill (primary use case)

```bash
# Add to your project's skills
mkdir -p .claude/skills
# Copy or symlink sage-agent-tempo skill files

# Create your checklist
cp templates/developer_checklist.yaml ./developer_checklist.yaml
# Edit with your project's tasks

# The Stop hook auto-triggers after each agent session
# When you're ready for reports:
npx sage-agent-tempo report
```

### As a CLI tool

```bash
# Install
npm install -g sage-agent-tempo

# Generate build log from existing session data
sage-agent-tempo parse --agent claude-code --checklist developer_checklist.yaml

# Generate all reports
sage-agent-tempo report --format all

# Generate specific report
sage-agent-tempo report --format dashboard
sage-agent-tempo report --format executive
sage-agent-tempo report --format excalidraw

# Backfill from old sessions (best-effort, no checklist correlation)
sage-agent-tempo backfill --since 2026-03-01
```

## The developer_checklist.yaml format

```yaml
project: my-project-name
description: Short description for report headers

phases:
  - id: setup
    name: Project Setup
    items:
      - id: "1.1"
        title: Initialize project scaffolding
        tags: [config]
        acceptance: package.json exists, TypeScript compiles
      - id: "1.2"
        title: Set up database connection
        tags: [backend]
        acceptance: Can connect and run migrations

  - id: core
    name: Core Features
    items:
      - id: "2.1"
        title: Build data ingestion pipeline
        tags: [backend]
        depends_on: ["1.2"]
        acceptance: Can ingest sample dataset
```

Tags drive the architecture breakdown in reports. Supported tags: `backend`, `frontend`, `mcp`, `tools`, `tests`, `config`, `docs`, `data`.

## Supported agents

| Agent | Session files | Parser status |
|-------|--------------|---------------|
| Claude Code | `~/.claude/projects/<path>/<session>.jsonl` | Primary target |
| OpenAI Codex | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | Secondary target |
| Future agents | TBD | Pluggable parser interface |

## Report outputs

### Executive summary (PDF/DOCX)

A document non-technical stakeholders can actually open, containing a one-page overview (total cost, duration, completion rate, test pass rate), per-phase breakdown with mini bar charts, top 3 most expensive checklist items, and architecture distribution.

### Interactive HTML dashboard

A single `.html` file (no server needed) with: Gantt chart showing checklist item timelines color-coded by phase, token burn rate over time, cost per checklist item (bar chart), architecture breakdown (donut chart), and test results summary. Uses Plotly.js bundled inline.

### Excalidraw diagrams

Architecture breakdown and timeline diagrams as `.excalidraw` JSON files, compatible with the `excalidraw-diagram-generator` Claude Code skill and excalidraw.com.

For automatic PNG export alongside `.excalidraw` files, optionally install:

```bash
npm install @swiftlysingh/excalidraw-cli
```

If installed, `.png` files are generated at 2x scale next to each `.excalidraw` file. If not installed, PNG export is silently skipped.

## Requirements

- Node.js 18+
- Claude Code (for skill usage and hooks)
- Git (for commit correlation)
- (Optional) `@swiftlysingh/excalidraw-cli` for PNG export of Excalidraw diagrams

## How it handles the hard parts

**Correlating turns to checklist items**: The parser looks for checklist item IDs or titles mentioned in user prompts and agent responses. When the agent says "Now working on 2.1" or "Moving on to the data ingestion pipeline," the correlator assigns subsequent turns to that item. Falls back to timestamp-based heuristics if no explicit mentions are found.

**Cost estimation on Pro/Max subscriptions**: Token counts are exact (from session files). Dollar costs are API-equivalent estimates via LiteLLM pricing data — useful for relative comparison ("feature A cost 3x more than feature B") even if you're not paying per-token.

**Multi-session builds**: A single checklist item might span multiple Claude Code sessions (you close the terminal and resume later). The correlator joins sessions by matching checklist item status across session boundaries.

## License

MIT
