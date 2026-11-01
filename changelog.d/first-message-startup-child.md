### Fixed
- A first message typed in the New tab or New workspace dialog goes to Claude Code once it is ready.
  It was often held as "the pane's terminal or agent session changed" or "the agent started for this
  message has ended", because it was bound to a program Claude Code runs as it starts (git, gh), not
  to Claude Code itself.
