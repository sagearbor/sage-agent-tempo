---
name: sage-agent-tempo
description: Track what AI agents build, how long it takes, and what it costs. Produces audit reports from session data.
hooks:
  Stop:
    - hooks:
        - type: command
          command: ./src/hooks/stop-hook.sh
          async: true
---

# sage-agent-tempo

This skill creates an audit trail of your AI agent development work.

## When to activate

Only follow these instructions when:
- The user mentions "sage-agent-tempo", "tempo", or "track this build"
- A `developer_checklist.yaml` already exists in the project root
- The project's CLAUDE.md references sage-agent-tempo

If none of these apply, ignore this skill entirely — do not create checklists or announce items unprompted.

## For agents working on a project with this skill

### Zero-setup: generating a checklist from spec

If the project has no `developer_checklist.yaml`, create one **immediately** — before doing any other work. This ensures all tokens are tracked from the very first turn.

1. **Look for any planning context**: `CLAUDE.md`, `README.md`, `PRP.md`, `PRD.md`, `SPEC.md`, or any document describing what needs to be built.

2. **Create a stub checklist right away**, even if the full scope is unknown. Include at least one item for the current work. For projects where the first task is research/discovery:

```yaml
project: project-name
phases:
  - id: discovery
    name: Discovery & Planning
    items:
      - id: "1.1"
        title: Research and document existing system
        tags: [docs]
        acceptance: |
          - Discovery documents written
          - Full developer_checklist.yaml generated from findings

  - id: placeholder
    name: Implementation (to be expanded)
    items:
      - id: "2.1"
        title: TBD — will be detailed after discovery
        tags: [backend]
```

3. **Say "Starting item 1.1"** before beginning discovery/research work. This captures those tokens under the discovery phase instead of losing them to overhead.

4. **Expand the checklist as you learn more.** After discovery, replace the placeholder phase with detailed items based on what you found. The checklist is a living document — update it throughout development.

5. **Commit the checklist** so other agents (and future sessions) can use it.

### During development

1. **Before starting work**, read `developer_checklist.yaml` to understand the plan.
2. **When you start an item**: say "Starting item X.Y" in your response.
3. **When you finish an item**: say "Completed item X.Y" in your response.
4. **When scope changes**: update `developer_checklist.yaml` — add new items with the next available ID, update titles, or mark status.
5. **If you are a subagent** (spawned by an orchestrator), do NOT modify `developer_checklist.yaml` directly. Instead, include a structured progress block at the end of your response (see TEMPO_STATUS format below).

### After work

Reports are generated via CLI:

```bash
npx sage-agent-tempo parse --agent claude-code
npx sage-agent-tempo report --format all
```

After generating reports, render `reports/*.excalidraw` files to PNG if possible.

### Where data lives

- **Checklist**: `developer_checklist.yaml` in the project root
- **Build log**: `build_log.json` (generated, gitignored)
- **Reports**: `reports/` directory (generated, gitignored)

### Supported tags

Use these tags in `developer_checklist.yaml` items for architecture breakdown:
`backend`, `frontend`, `mcp`, `tools`, `tests`, `config`, `docs`, `data`

### Keeping the checklist small

When many items are complete, collapse them to save agent context:

```bash
npx sage-agent-tempo collapse
```

This strips acceptance/notes/priority from done items, keeping only id, title, tags, and `status: done`.

### TEMPO_STATUS format (for subagents)

If you are a subagent, do NOT modify `developer_checklist.yaml` directly. Instead, include this block at the end of your response:

```
TEMPO_STATUS:
- completed: "2.1"
- completed: "2.2"
- in_progress: "2.3"
- discovered: { title: "Handle edge case X", phase: "core", tags: [backend] }
```

The orchestrator or a dedicated sync agent will update the YAML from these reports. This avoids parallel write conflicts and keeps your context focused on your actual work.
