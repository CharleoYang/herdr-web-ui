### Maintenance
- Reuse the real pending-input browser scene in a focused smoke command and correlate reconnect
  submissions with user intent, socket, pane, bridge acceptance and raw PTY bytes instead of counting
  lifetime terminal traffic.
- Ensure optional pending-smoke diagnostics cannot skip owned context, workspace or temporary-root
  cleanup; preserve the original scenario error and report secondary failures.
