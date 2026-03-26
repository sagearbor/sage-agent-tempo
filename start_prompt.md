You are building the sage-agent-tempo project. Read the developer_checklist.yaml and README.md in this repo for full context.

IMPORTANT INSTRUCTIONS:
1. Read developer_checklist.yaml COMPLETELY before starting any work
2. Announce "Starting item X.Y: <title>" before beginning each checklist item
3. Announce "Completed item X.Y" when acceptance criteria are met
4. Run tests after every phase to verify nothing is broken

BUILD STRATEGY — use parallel agents where possible:

STEP 1 (sequential — foundation must come first):
  Complete Phase 1 (Foundation) items 1.1, 1.2, 1.3 in order.
  These create the project skeleton, types, and schemas everything else depends on.

STEP 2 (parallel — fan out after foundation):
  Launch these as parallel agents/tasks:
  
  Agent A: Phase 2 — Parsers (items 2.1, 2.2, 2.3)
    Focus: Claude Code JSONL parser, Codex parser, registry
    
  Agent B: Phase 3 — Collectors (items 3.1, 3.2, 3.3)  
    Focus: Git collector, test results parser, file categorizer

STEP 3 (sequential — needs parsers + collectors done):
  Complete Phase 4 — Correlator (items 4.1, 4.2, 4.3)
  This joins all data streams into build_log.json

STEP 4 (parallel — all reporters are independent):
  Launch these as parallel agents/tasks:
  
  Agent C: Item 5.1 — HTML dashboard generator
  Agent D: Item 5.2 — Executive summary generator  
  Agent E: Item 5.3 — Excalidraw diagram generator

STEP 5 (sequential):
  Complete Phase 6 — Integration (items 6.1, 6.2, 6.3, 6.4)
  Hooks, CLI, SKILL.md, docs

STEP 6 (sequential):
  Complete Phase 7 — Testing (items 7.1, 7.2, 7.3, 7.4)
  Fixtures, coverage, e2e tests, error handling

After each phase, run: npm run build && npm run test
Commit working code after each phase with message: "phase N: <phase name>"
