### Fixed
- A Claude Code pane whose session has kept thousands of subagent transcripts no longer has the
  server check every one of them on each status poll: files last written over a day ago are
  checked again once a minute, so the server's event loop stays free for terminals and requests.
