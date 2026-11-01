### Fixed
- Over the relay in Firefox, a request made before the connection dropped (such as a prompt answer)
  now fails as not sent instead of going out on the reconnected link, and an upload over the PC's
  limit is refused before Firefox reads it into memory.
- A relay terminal socket that is sent more than 4 MiB faster than it can hand it on now fails like
  a browser socket with a full send buffer, instead of queueing it all in memory.
