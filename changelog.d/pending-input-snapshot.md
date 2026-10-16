### Maintenance
- Reuse the real pending-input browser scene in a focused smoke command and correlate reconnect
  submissions with user intent, socket, pane, bridge acceptance and raw PTY bytes instead of counting
  lifetime terminal traffic.
- Ensure optional pending-smoke diagnostics cannot skip owned context, workspace or temporary-root
  cleanup; preserve the original scenario error and report secondary failures.
- Correlate remaining browser input assertions with each action while preserving exact message types,
  raw key and IME bytes, routing and delayed-duplicate checks; normalize wrappers only for clipboard
  paste, not keyboard events or queued message text. Honor the protocol's omitted-immediate delivery
  default when checking explicit Send now.
- Return pending-scene workspace ownership to the full browser runner for its existing cleanup.
- Account for native DA1/DECRQM replies only with matching queries on the same socket, pane and
  attachment lifetime; retain exact foreground key bytes, physical markers and foreign-pane checks.
