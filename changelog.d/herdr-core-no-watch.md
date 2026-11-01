### Fixed
- With `OVIS_RUNTIME=herdr-core`, a tab no longer stays paused after a reconnect, and a tab out of use
  no longer starts herdr's read-only view, which cannot reach herdr-core and only logged a failure:
  the server offers no watch there, so a reconnecting tab attaches again at once and a tab out of use
  keeps its last screen until you are back.
