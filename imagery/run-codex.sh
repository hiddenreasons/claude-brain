#!/bin/zsh
# Makes the two brain stills with Codex (GPT-6 Astra). Writes only into brain/static/media.
# Uses Anthony's ChatGPT Pro Codex allowance; no money is charged.
set -euo pipefail
ROOT="/Users/anthony/Documents/Active Projects/Claude Brain"
CODEX=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
"$CODEX" exec -m gpt-6-astra -c model_reasoning_effort='"high"' \
  --sandbox workspace-write --skip-git-repo-check \
  -C "$ROOT/brain/static/media" \
  -i "/Users/anthony/Desktop/claude brain/2.png" \
  -i "/Users/anthony/Desktop/claude brain/3.png" \
  -- "$(cat "$ROOT/imagery/codex-brains-brief.md")" < /dev/null 2>&1 | tee "$ROOT/imagery/codex-run.log"
echo "CODEX_EXIT=${pipestatus[1]}"
