### Fixed
- Opening a Claude Code pane's background-task list reads its subagent history on a file thread,
  so that request's filesystem work no longer blocks other requests and terminal connections.
