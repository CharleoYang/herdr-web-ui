### Added
- OMP Chat shows saved `/btw` questions, Markdown answers, follow-ups and recorded statuses in a
  separate collapsible panel. Visible panes refresh the sidecar independently of the main
  conversation; sending, cancellation and branching remain in OMP.
- Close hides the entire BTW region and stops its refreshes. More → Side conversations (BTW)
  restores it; this browser remembers the choice per PC/pane across reloads and view switches
  without deleting saved answers. Page-local visibility still works when storage writes fail,
  and the restore item remains available while a hidden pane's agent label changes.
- BTW reads use browser-compatible abort deadlines and tolerate topics deleted during a read;
  malformed or unreadable saved topics still report an error.
