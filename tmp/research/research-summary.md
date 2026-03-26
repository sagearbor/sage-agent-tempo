# Logging Robustness Research — 5 Agent Comparison

## Comparison Table

| Area | Key Finding | Severity | Recommended Fix | Effort |
|------|------------|----------|----------------|--------|
| **1. Session Architecture** | Subagent files inherit parent sessionId; continuation sessions copy parent records as prefix; `isSidechain` and `cwd` fields exist but aren't used | High | Use `isSidechain` field + `cwd` for project validation; parse `meta.json` companion files for subagent context | Medium |
| **2. Correlator Accuracy** | Only 3.6% of turns have explicit "Starting item X.Y"; 12.6% have work intent ("Let me build...") that's ignored; file-path matching is too conservative | High | Add work intent patterns (+15%), tool chain correlation (+10%), planning exclusion (+5%), semantic title matching (+8%) | Medium |
| **3. Multi-Repo** | Fallback scans ALL projects when slug doesn't match — broken. Worktrees are separate dirs. No dedup across projects. Path collisions possible. | Critical | Remove fallback (error instead), validate `cwd` field in records, handle worktrees as same repo | Low-Med |
| **4. Timestamps** | Timestamps ARE reliable — the 3610h bug was cross-project mixing (fixed). Current overhead exclusion is unnecessary hack. | Medium | Infer session bounds from first/last assistant record; filter turns by bounds; remove overhead exclusion | Low |
| **5. Alternatives** | Hybrid approach wins: Stop hook self-report + post-hoc parsing. MCP server too heavy. Git-based too coarse. ccusage not installed. Real-time hooks unproven. | Strategic | Add Stop hook prompt asking agent "what items did you work on?" + validate against post-hoc correlations | Medium |

## Cross-Cutting Themes

### What all 5 agents agree on:
1. **The `cwd` field in JSONL records is the key unused asset** — every record has the working directory, which definitively identifies the project. We should validate records against expected cwd instead of relying on filesystem path alone.
2. **Subagent handling needs `meta.json`** — companion files contain `agentType` and `description` that can improve correlation.
3. **The fallback to scanning all projects is dangerous** — should error instead of silently mixing data.
4. **Timestamps are actually fine** — the duration bugs were from cross-project contamination, not bad timestamps.
5. **Work intent detection is the biggest accuracy win** — catching "Let me build X" patterns would recover 12.6% of turns.

## Recommended Path Forward

### Phase 1: Fix the Dangerous Stuff (1-2 hours)
1. **Remove fallback scanning** — error with helpful message instead of scanning all projects
2. **Validate `cwd` field** — filter records where `cwd` doesn't match expected project path
3. **Remove overhead exclusion hack** — use session bounds (first/last assistant timestamp) for duration

### Phase 2: Improve Accuracy (2-3 hours)
4. **Add work intent patterns** — "Let me build", "Now I will implement", "I need to create" → match to item by title similarity
5. **Use `meta.json`** — read subagent description for item context
6. **Planning turn exclusion** — filter summary/status turns before correlation
7. **Remove overhead duration hack** — trust timestamps after Phase 1 fixes

### Phase 3: Hybrid Self-Report (3-4 hours)
8. **Enhanced Stop hook** — prompt agent at session end: "Which items did you work on?"
9. **MCP tool (optional)** — `tempo_progress()` tool agents can call mid-session
10. **Validate self-report against post-hoc** — cross-reference for confidence scoring

### Expected Accuracy Improvement
- Current: ~50-60% of turns matched to items
- After Phase 1: ~60-65% (cleaner data, fewer false positives)
- After Phase 2: ~80-85% (work intent + semantic matching)
- After Phase 3: ~90-95% (agent self-report validation)
