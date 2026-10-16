### Changed
- `bun run smoke:pending-input` runs the real pending-input browser scene without the full
  journey. A reconnect submission is tied to the user action, socket, pane, bridge acceptance
  and raw PTY bytes, and a diagnostic failure still closes the owned workspace.
