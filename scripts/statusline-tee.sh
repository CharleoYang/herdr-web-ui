#!/bin/sh
# Keeps the payload Claude Code pipes to its status line (five-hour and weekly limits, context
# window, cost) where the herdr web UI can read it, then draws the line exactly as before.
#
# Installed by scripts/install-statusline-tee.ts, which also puts the command that was there before
# in ~/.herdr/statusline-original.json. Read by server/statusline.ts.
payload=$(cat)
tmp="$HOME/.herdr/statusline-last.json.$$"
printf '%s' "$payload" > "$tmp" 2>/dev/null && mv -f "$tmp" "$HOME/.herdr/statusline-last.json" 2>/dev/null || rm -f "$tmp"
printf '%s' "$payload" | "$HOME/.claude/statusline.sh"
