#!/bin/zsh
# Codex (GPT-6 Astra, medium) writes the Runway motion prompts. Writes only into imagery/.
set -euo pipefail
ROOT="/Users/anthony/Documents/Active Projects/Claude Brain"
CODEX=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
"$CODEX" exec -m gpt-6-astra -c model_reasoning_effort='"medium"' \
  --sandbox workspace-write --skip-git-repo-check \
  -C "$ROOT/imagery" \
  -i "$ROOT/brain/static/media/claude-brain.png" \
  -i "$ROOT/brain/static/media/mac-brain.png" \
  -- "$(cat "$ROOT/imagery/runway-prompts-brief.md")" < /dev/null 2>&1 | tee "$ROOT/imagery/codex-prompts-run.log"
echo "CODEX_EXIT=${pipestatus[1]}"
