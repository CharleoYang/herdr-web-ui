### Fixed
- Chat keeps a turn's words and tool calls in the order the agent wrote them, as the terminal
  does: text written before a tool call no longer drops below every command of the turn.
