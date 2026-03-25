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

## For agents working on a project with this skill

### Announce checklist items

When you start working on a checklist item, say "Starting item X.Y" (e.g., "Starting item 2.1"). This lets the tracker correlate your turns to specific items.

### Where data lives

- **Checklist**: `developer_checklist.yaml` in the project root
- **Build log**: `build_log.json` (generated, gitignored)
- **Reports**: `reports/` directory (generated, gitignored)

### Generating reports

After completing work, run:

```bash
npx sage-agent-tempo report --format all
```

This produces:
- `reports/dashboard.html` — Interactive HTML dashboard with charts
- `reports/executive-summary.html` — Print-friendly executive summary
- `reports/architecture.excalidraw` — Architecture diagram
- `reports/timeline.excalidraw` — Timeline diagram

### Supported tags

Use these tags in `developer_checklist.yaml` items for architecture breakdown:
`backend`, `frontend`, `mcp`, `tools`, `tests`, `config`, `docs`, `data`
