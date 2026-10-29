### Changed
- A message sent from Chat stays in view as a quiet bubble, "Sent · waiting for the agent's next
  turn", until the agent writes it as a turn, so the chat is never blank between Send and the
  agent's turn. A command (`/cost`, `! ls`) gets no bubble, since it never comes back as that
  message, and a bubble whose turn has not come within a minute goes.
