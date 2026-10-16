### Added
- OMP chat panes offer a searchable, session-only model switcher backed by the selected PC's
  installed chat models. Switching waits for an idle agent and uses the existing terminal submit path.
- Each chat pane keeps its latest phase-grouped todo progress in one collapsible panel above
  the composer, outside the message scroller. Flat OMP initialization, Claude TodoWrite and
  Codex plans are supported; clearing a list no longer revives older items.
- The machine roster uses its existing SSE snapshots instead of redundant five-second browser
  reads once the current stream is healthy. It retains a visible-page REST backstop within
  30 seconds, five-second fallback before a valid snapshot or after stream failure, and fresh
  reads on visibility restore or explicit changes. Health/auth polling is unchanged.
- Capability-advertising bridges push conversation deltas and prompt changes over the existing
  WebSocket. Visible chats avoid the old two-second refresh delay and idle prompt polling;
  older bridges retain REST fallback, with REST reconciliation on reconnect and visibility restore.
- Claude teammate deliveries render as collapsible agent cards rather than user-message XML/JSON.
  Idle notifications show availability, not a success verdict; their result renders as Markdown.
  The original delivery remains available. This is display-only and does not alter transcript
  records, permissions, task execution or agent state.

### Fixed
- Historical native Ask calls show every question and option as readable, read-only transcript
  content instead of clipped JSON, preserving descriptions, previews and cancellation output.
- The bottom-pinned Todo panel points its caret up when collapsed and down when expanded,
  matching its upward expansion. Other disclosure carets keep their existing directions.
