#!/bin/sh
# Keeps the payload Claude Code pipes to its status line (five-hour and weekly limits, context
# window, cost) where the herdr web UI can read it, then draws the line exactly as before.
#
# Installed by scripts/install-statusline-tee.ts, which also puts the command that was there before
# in ~/.herdr/statusline-original.json. Read by server/statusline.ts.
payload=$(cat)
# Keep the restrictive umask scoped to capture; the original command keeps its environment.
(umask 077; printf '%s' "$payload" | "bun" "$HOME/.herdr/statusline-capture.ts") 2>/dev/null
printf '%s' "$payload" | "$HOME/.claude/statusline.sh"
