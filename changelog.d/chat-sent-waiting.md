### Changed
- A message sent from Chat stays in view as "Sent · waiting for the agent's next turn" until the
  agent writes it as a turn, so the chat is never blank between Send and the agent's turn. A
  command (`/cost`, `! ls`) gets no such line, since it never comes back as that message.
- Claude Code's "Not confirmed" note after a cleared terminal draft is information, not a warning,
  and offers no Send anyway: the message may already be queued there.
