### Added
- Large files and videos over the relay keep up to 384 KiB in flight, so a download isn't held
  back by waiting for each receipt (over 5 MB/s at a 50 ms round trip), while terminal output still
  goes ahead of it.
