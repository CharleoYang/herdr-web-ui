### Added
- Claude's five-hour and weekly limits can come from Claude Code's own status line where
  Anthropic's usage endpoint is blocked (it answers 403 from some networks). Opt in with
  `bun scripts/install-statusline-tee.ts` on the PC that runs Claude Code: it wraps the status line
  set in Claude's `settings.json` (under `CLAUDE_CONFIG_DIR` too) and runs that command unchanged,
  keeping only the two windows and the account, owner-only, in `~/.herdr/statusline-last.json`.
  `--remove` puts `settings.json` back as it was and deletes what the install added. A reading
  counts only for the account that drew it and only until its window resets; the endpoint stays
  the fallback. By @CharleoYang.
- omp's context ring shows a percent, read from the context figure in omp's own status bar while
  the pane is scrolled to the bottom. By @CharleoYang.

### Changed
- The composer's usage chip shows both the five-hour and the weekly window (`5h 83% · wk 36%`). On
  a local Claude pane it also shows with Subscription usage off, then reading only the status-line
  capture on the PC and asking no provider.
