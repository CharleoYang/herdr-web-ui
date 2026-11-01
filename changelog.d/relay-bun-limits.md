### Fixed
- Limit self-hosted relay connections, rooms, open sockets per address and address bookkeeping by
  default, with configurable per-address and global rate budgets.
- Close a relay client that waits 30 s for a PC that is not connected, so waiting clients cannot
  fill the relay while the PC is away.
