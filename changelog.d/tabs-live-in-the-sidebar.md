### Removed
- The tab strip is gone, on every screen: a tab's pane is selected from the sidebar's rows, which
  now list every pane, a shell's included. The strip's own chords (`Alt+Shift+←/→`, `Shift+F10`)
  went with it; Previous/Next pane (`Mod+Shift+↑/↓`) walks the same order, and a Settings binding
  can put the old keys back on it.

### Added
- A `+` at each head: a workspace's head opens an empty tab there, and a coding agent's head opens a
  tab running that agent in its first workspace.
- A tab's actions are its row's menu: Rename tab (a field in that row, Enter or a click elsewhere
  saving it), Move tab left/right, Move to workspace…, and Close tab.

### Changed
- The Agents tree lists panes rather than agents alone: a pane that runs no agent heads a Shell, and
  its row opens its pane exactly as an agent's does.
- DESIGN.md's tab section describes the sidebar, the heads' `+` and the rows' tab menu.
