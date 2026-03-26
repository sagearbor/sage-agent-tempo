#!/usr/bin/env bash
# sage-agent-tempo: Claude Code Stop hook
# Triggers the JSONL parser after each agent session ends.
#
# Install in .claude/settings.json:
# {
#   "hooks": {
#     "Stop": [{
#       "hooks": [{
#         "type": "command",
#         "command": "path/to/stop-hook.sh"
#       }]
#     }]
#   }
# }
#
# Reads JSON from stdin: { "session_id": "...", "transcript_path": "...", "cwd": "..." }

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).session_id||'')}catch{console.log('')}})" 2>/dev/null || echo "")
CWD=$(echo "$INPUT" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).cwd||'')}catch{console.log('')}})" 2>/dev/null || echo "")

if [ -z "$SESSION_ID" ] || [ -z "$CWD" ]; then
  exit 0
fi

# Check if sage-agent-tempo is available
if ! command -v sage-agent-tempo &>/dev/null; then
  # Try npx as fallback
  if [ -f "$CWD/node_modules/.bin/sage-agent-tempo" ]; then
    TEMPO="$CWD/node_modules/.bin/sage-agent-tempo"
  else
    exit 0
  fi
else
  TEMPO="sage-agent-tempo"
fi

# Check if project has a checklist
if [ ! -f "$CWD/developer_checklist.yaml" ]; then
  exit 0
fi

# Extract TEMPO_STATUS item IDs from the transcript (if available)
TRANSCRIPT_PATH=$(echo "$INPUT" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).transcript_path||'')}catch{console.log('')}})" 2>/dev/null || echo "")

SELF_REPORT_ARG=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  # Scan transcript for TEMPO_STATUS blocks and extract item IDs
  ITEMS=$(node -e "
    const fs = require('fs');
    try {
      const content = fs.readFileSync(process.argv[1], 'utf-8');
      const match = content.match(/TEMPO_STATUS:\\s*\\n((?:\\s*-\\s+(?:completed|in_progress|discovered):.*\\n?)*)/);
      if (match) {
        const ids = [];
        const re = /^\\s*-\\s+(?:completed|in_progress):\\s*\"([^\"]+)\"/gm;
        let m;
        while ((m = re.exec(match[1])) !== null) ids.push(m[1]);
        if (ids.length > 0) console.log(ids.join(','));
      }
    } catch {}
  " "$TRANSCRIPT_PATH" 2>/dev/null || echo "")

  if [ -n "$ITEMS" ]; then
    SELF_REPORT_ARG="--self-report $ITEMS"
  fi
fi

# Run parser (async, don't block Claude Code)
cd "$CWD"
# shellcheck disable=SC2086
$TEMPO parse --agent claude-code --checklist developer_checklist.yaml $SELF_REPORT_ARG &>/dev/null &

exit 0
