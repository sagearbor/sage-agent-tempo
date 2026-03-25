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

### Checklist tracking

If the project has a `developer_checklist.yaml`, track your progress:

1. **When you start an item**: say "Starting item X.Y" in your response
2. **When you finish an item**: say "Completed item X.Y"
3. **When you discover new work**: add items to `developer_checklist.yaml` with the next available ID
4. **When scope changes**: update the item's title/acceptance in the YAML

If no checklist exists yet, generate one from the project's spec/PRP as your first task. Use this format:

```yaml
project: project-name
phases:
  - id: phase-id
    name: Phase Name
    items:
      - id: "1.1"
        title: What to build
        tags: [backend]
        acceptance: |
          - How to verify it works
```

### Subagent progress reporting

**If you are a subagent** (spawned by an orchestrator), do NOT modify `developer_checklist.yaml` directly. Instead, include a structured progress block at the end of your response:

```
TEMPO_STATUS:
- completed: "2.1"
- completed: "2.2"
- in_progress: "2.3"
- discovered: { title: "Handle edge case X", phase: "core", tags: [backend] }
```

The orchestrator or a dedicated sync agent will update the YAML from these reports. This avoids parallel write conflicts and keeps your context focused on your actual work.

### Where data lives

- **Checklist**: `developer_checklist.yaml` in the project root
- **Build log**: `build_log.json` (generated, gitignored)
- **Reports**: `reports/` directory (generated, gitignored)

### Generating reports

After completing work, run:

```bash
npx sage-agent-tempo parse --agent claude-code
npx sage-agent-tempo report --format all
```

### Keeping the checklist small

When many items are complete, collapse them to save agent context:

```bash
npx sage-agent-tempo collapse
```

This strips acceptance/notes/priority from done items, keeping only id, title, tags, and `status: done`.

### Enhancing diagrams with excalidraw skill

After generating reports, if the `excalidraw-diagram-generator` skill is available, use it to re-render the architecture and timeline diagrams for better visual quality:

1. Read `reports/architecture.excalidraw` and `reports/timeline.excalidraw`
2. Use the excalidraw-diagram-generator skill to regenerate each one with a description based on the build log data (architecture breakdown, timeline phases, token distribution)
3. The skill produces more polished, hand-drawn-style diagrams with better layout and arrows

This is optional — the base `.excalidraw` files from `sage-agent-tempo report` always work. The skill enhancement is a nice-to-have when running inside Claude Code.

### Supported tags

Use these tags in `developer_checklist.yaml` items for architecture breakdown:
`backend`, `frontend`, `mcp`, `tools`, `tests`, `config`, `docs`, `data`
